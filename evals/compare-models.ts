// BE-46: comparativa de modelos — corre los mismos datasets de evals/ contra UNA estrategia/modelo
// aislada por vez (sin el loop de fallback de AIExtractorContext), para poder medir accuracy ×
// costo × latencia de cada modelo por separado y justificar con datos la elección de
// gemini-2.5-flash-lite como primario / gpt-4o-mini como fallback (hoy hardcodeada sin evidencia,
// ver ai.ts). Resultado consumido por docs/model-selection.md.
//
// A propósito NO pasa por extractFromTextInput/extractZoneIntent/etc. (que sí tienen fallback,
// tracing y persistencia en llm_calls) — acá se llama directo al método de la estrategia y se
// normaliza con las mismas funciones puras de ai.ts (normalizeAgent1/normalizeAgent2/
// normalizeSegmentResult/normalizeExcelMappingResult), así que el resultado es exactamente
// comparable al de evals/run.ts pero aislando una sola llamada LLM por caso, sin red de
// seguridad de fallback ni resolución de zona contra la base (ninguna métrica de esta operación
// depende de zona_ids/zona_nombres — ver evals/metrics.ts#ZoneActualShape).
import * as fs from 'fs';
import * as path from 'path';
import {
  GeminiStrategy,
  OpenAIStrategy,
  AIStrategy,
  UsageCallback,
  normalizeAgent1,
  normalizeAgent2,
  normalizeSegmentResult,
  normalizeExcelMappingResult,
  SYSTEM_INSTRUCTIONS_AGENT1_TEXT_INPUT,
  SYSTEM_INSTRUCTIONS_AGENT2,
  SYSTEM_INSTRUCTIONS_SEGMENTER,
  SYSTEM_INSTRUCTIONS_EXCEL_MAPPING
} from '../src/services/ai';
import { estimateCostUsd } from '../src/config/modelPricing';
import {
  ALL_OPERATIONS,
  OperationName,
  ExtractIntentCase,
  ZoneCase,
  SegmentCase,
  ExcelMappingCase,
  DATASET_FILES,
  loadJsonl,
  latencyStats,
  ExecutedCase,
  computeExtractIntentMetrics,
  aggregateExtractIntent,
  computeZoneMetrics,
  aggregateZone,
  computeSegmentMetrics,
  aggregateSegment,
  computeExcelMappingMetrics,
  aggregateExcelMapping,
  METRIC_LABELS,
  formatMetricValue,
  mean
} from './metrics';

// --- Candidatos de la comparativa ---
// gemini-2.5-flash-lite: primario actual. gpt-4o-mini: fallback actual. gemini-2.5-flash: candidato
// "más grande" (misma familia que el primario, para aislar el efecto de tamaño/capacidad del de
// cambiar de proveedor) — ver docs/model-selection.md para la decisión final.
interface ModelCandidate {
  label: string;
  model: string;
  makeStrategy: () => AIStrategy;
}

const CANDIDATES: ModelCandidate[] = [
  { label: 'gemini-2.5-flash-lite (primario actual)', model: 'gemini-2.5-flash-lite', makeStrategy: () => new GeminiStrategy('gemini-2.5-flash-lite') },
  { label: 'gpt-4o-mini (fallback actual)', model: 'gpt-4o-mini', makeStrategy: () => new OpenAIStrategy('gpt-4o-mini') },
  { label: 'gemini-2.5-flash (candidato "más grande")', model: 'gemini-2.5-flash', makeStrategy: () => new GeminiStrategy('gemini-2.5-flash') }
];

// --- Throttle + retry ante 429 de cuota ---
// Hallazgo de la primera corrida real (2026-10-30): con la API key de Gemini free tier usada en
// este entorno, gemini-2.5-flash-lite y gemini-2.5-flash devolvieron 429 RESOURCE_EXHAUSTED en la
// mayoría de los casos (10 req/min y 5 req/min respectivamente — ver
// https://ai.google.dev/gemini-api/docs/rate-limits) al no haber ningún espaciado entre llamadas
// (ai.ts no reintenta llamadas a LLM, withRetry.ts documenta explícitamente que no es para IA).
// gpt-4o-mini no tuvo ningún 429 en la misma corrida (0 errores en 160 casos). Sin este fix, la
// comparativa mediría cuota agotada, no calidad del modelo.
const RATE_LIMIT_MIN_INTERVAL_MS: Record<string, number> = {
  'gemini-2.5-flash-lite': 6_500, // límite observado: 10 req/min -> 1 cada 6s, +margen
  'gemini-2.5-flash': 13_000 // límite observado: 5 req/min -> 1 cada 12s, +margen
};

const lastCallAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function throttleForModel(model: string): Promise<void> {
  const minInterval = RATE_LIMIT_MIN_INTERVAL_MS[model];
  if (!minInterval) return;
  const last = lastCallAt.get(model);
  if (last !== undefined) {
    const wait = minInterval - (Date.now() - last);
    if (wait > 0) await sleep(wait);
  }
  lastCallAt.set(model, Date.now());
}

function parseRetryDelayMs(error: unknown): number | null {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const parsed = JSON.parse(message);
    const details = parsed?.error?.details;
    if (!Array.isArray(details)) return null;
    const retryInfo = details.find((d: any) => typeof d?.['@type'] === 'string' && d['@type'].endsWith('RetryInfo'));
    const retryDelay = retryInfo?.retryDelay as string | undefined;
    if (!retryDelay) return null;
    const seconds = parseFloat(retryDelay.replace('s', ''));
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
  } catch {
    return null;
  }
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.toLowerCase().includes('rate limit');
}

// Hallazgo real (2026-10-30, mismo día): además del límite por minuto, el free tier de Gemini
// tiene un tope DIARIO por modelo ("Generate content requests per day limit exceeded", 20 req/día
// para gemini-2.5-flash-lite) — con un retryDelay del orden de horas, no segundos. Reintentar o
// (peor) dormir ese retryDelay literal rompería el script durante horas. Una vez detectado, se
// marca el modelo como agotado por hoy — ninguna llamada posterior a ESE modelo intenta siquiera
// pegarle a la red, solo falla rápido (evita gastar los pocos requests que puedan quedar en
// reintentos inútiles y acelera el resto de la corrida).
const dailyQuotaExhausted = new Set<string>();

function isDailyQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('per day');
}

// El throttle proactivo evita la gran mayoría de los 429 por minuto; esto es la red de seguridad
// para el resto (ráfagas en el borde de la ventana, retraso de reloj, etc.) — hasta 3 reintentos,
// esperando lo que el proveedor indique (`retryDelay`) o 65s por defecto (la ventana de cuota por
// minuto de Gemini es de 60s). Un 429 de cuota DIARIA nunca se reintenta (ver dailyQuotaExhausted
// arriba). Cualquier otro error se relanza de inmediato, sin reintentar.
// `onLatency` reporta SOLO el tiempo del intento que efectivamente respondió (éxito o error no
// reintentable) — el tiempo de espera de throttleForModel/sleep nunca entra en la latencia
// reportada, para no mezclar "cuánto tardó el proveedor" con "cuánto esperamos por cuota".
async function callWithRateLimitRetry<T>(model: string, fn: () => Promise<T>, onLatency: (ms: number) => void): Promise<T> {
  if (dailyQuotaExhausted.has(model)) {
    onLatency(0);
    throw new Error(`Cuota diaria de ${model} ya agotada en esta corrida (sin reintentar).`);
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await throttleForModel(model);
    const start = Date.now();
    try {
      const result = await fn();
      onLatency(Date.now() - start);
      return result;
    } catch (error) {
      onLatency(Date.now() - start);
      if (isDailyQuotaError(error)) {
        dailyQuotaExhausted.add(model);
        console.log(`\n  (cuota DIARIA de ${model} agotada — se deja de intentar con este modelo por el resto de la corrida)`);
        throw error;
      }
      if (!isRateLimitError(error) || attempt === maxAttempts) throw error;
      const waitMs = parseRetryDelayMs(error) ?? 65_000;
      console.log(`\n  (429 en ${model}, intento ${attempt}/${maxAttempts} — esperando ${Math.ceil(waitMs / 1000)}s)`);
      await sleep(waitMs);
    }
  }
  throw new Error('unreachable');
}

// --- Ejecuta un dataset completo contra UNA estrategia, capturando costo por caso ---

interface ExecutedCaseWithCost<TMetrics> extends ExecutedCase<TMetrics> {
  costUsd: number;
}

async function runCasesWithCost<TCase extends { id: string; tags: string[] }, TMetrics>(
  cases: TCase[],
  model: string,
  callAndEvaluate: (c: TCase, onUsage: UsageCallback, onLatency: (ms: number) => void) => Promise<TMetrics>
): Promise<ExecutedCaseWithCost<TMetrics>[]> {
  const results: ExecutedCaseWithCost<TMetrics>[] = [];
  for (const c of cases) {
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let latencyMs = 0;
    try {
      const metrics = await callAndEvaluate(
        c,
        info => { usage = { inputTokens: info.inputTokens, outputTokens: info.outputTokens }; },
        ms => { latencyMs = ms; }
      );
      results.push({ id: c.id, tags: c.tags, latencyMs, metrics, costUsd: estimateCostUsd(model, usage) });
    } catch (error) {
      results.push({ id: c.id, tags: c.tags, latencyMs, executionError: (error as Error).message, costUsd: 0 });
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return results;
}

function meanCost(results: ExecutedCaseWithCost<unknown>[]): number {
  const successful = results.filter(r => !r.executionError);
  return mean(successful.map(r => r.costUsd));
}

// --- Una operación contra una estrategia aislada ---

interface OperationComparisonResult {
  operation: OperationName;
  totalCases: number;
  executedCases: number;
  executionErrors: { id: string; error: string }[];
  latency: { p50: number; p95: number; meanMs: number };
  meanCostUsdPerCall: number;
  metrics: Record<string, number>;
}

// maxCasesPerOp: toma solo los primeros N casos de cada dataset — pensado para modelos con cuota
// diaria de free tier escasa (ver dailyQuotaExhausted arriba), donde correr el dataset completo
// (78/30/27/25 casos) no entra en lo que queda de cuota del día. undefined = dataset completo.
async function runOperationForStrategy(op: OperationName, candidate: ModelCandidate, maxCasesPerOp?: number): Promise<OperationComparisonResult> {
  const strategy = candidate.makeStrategy();
  const limitCases = <T,>(all: T[]): T[] => (maxCasesPerOp !== undefined ? all.slice(0, maxCasesPerOp) : all);

  if (op === 'extract-intent') {
    const cases = limitCases(loadJsonl<ExtractIntentCase>(DATASET_FILES[op]));
    const results = await runCasesWithCost(cases, candidate.model, async (c, onUsage, onLatency) => {
      const raw = await callWithRateLimitRetry(candidate.model, () => strategy.extractFromFreeText(c.input, SYSTEM_INSTRUCTIONS_AGENT1_TEXT_INPUT, onUsage), onLatency);
      return computeExtractIntentMetrics(c.expected, normalizeAgent1(raw));
    });
    const agg = aggregateExtractIntent(results);
    return {
      operation: op,
      totalCases: cases.length,
      executedCases: agg.n,
      executionErrors: results.filter(r => r.executionError).map(r => ({ id: r.id, error: r.executionError! })),
      latency: latencyStats(results),
      meanCostUsdPerCall: meanCost(results),
      metrics: {
        operationMatchRate: agg.operationMatchRate,
        propertyTypeMatchRate: agg.propertyTypeMatchRate,
        currencyMatchRate: agg.currencyMatchRate,
        countryMatchRate: agg.countryMatchRate,
        bedroomsMatchRate: agg.bedroomsMatchRate,
        budgetMeanAbsError: agg.budgetMeanAbsError,
        budgetNullMismatchRate: agg.budgetNullMismatchRate,
        zonesPrecision: agg.zonesPrecision,
        zonesRecall: agg.zonesRecall,
        keyFeaturesPrecision: agg.keyFeaturesPrecision,
        keyFeaturesRecall: agg.keyFeaturesRecall,
        desconocidaRate: agg.desconocidaRate,
        falseDesconocidaRate: agg.falseDesconocidaRate
      }
    };
  }

  if (op === 'zone') {
    const cases = limitCases(loadJsonl<ZoneCase>(DATASET_FILES[op]));
    const results = await runCasesWithCost(cases, candidate.model, async (c, onUsage, onLatency) => {
      const raw = await callWithRateLimitRetry(candidate.model, () => strategy.extractZoneIntent(c.input, SYSTEM_INSTRUCTIONS_AGENT2, c.operacion_hint ?? undefined, onUsage), onLatency);
      const actual = normalizeAgent2(raw, c.operacion_hint ?? undefined);
      return computeZoneMetrics(c.expected, actual);
    });
    const agg = aggregateZone(results);
    return {
      operation: op,
      totalCases: cases.length,
      executedCases: agg.n,
      executionErrors: results.filter(r => r.executionError).map(r => ({ id: r.id, error: r.executionError! })),
      latency: latencyStats(results),
      meanCostUsdPerCall: meanCost(results),
      metrics: {
        zonaCorrectaRate: agg.zonaCorrectaRate,
        zonaPrecision: agg.zonaPrecision,
        zonaRecall: agg.zonaRecall,
        dormitoriosMatchRate: agg.dormitoriosMatchRate,
        caracteristicasPrecision: agg.caracteristicasPrecision,
        caracteristicasRecall: agg.caracteristicasRecall,
        operacionMatchRate: agg.operacionMatchRate,
        desconocidaRate: agg.desconocidaRate,
        falseDesconocidaRate: agg.falseDesconocidaRate
      }
    };
  }

  if (op === 'segment') {
    const cases = limitCases(loadJsonl<SegmentCase>(DATASET_FILES[op]));
    const results = await runCasesWithCost(cases, candidate.model, async (c, onUsage, onLatency) => {
      const raw = await callWithRateLimitRetry(candidate.model, () => strategy.segmentSearchRequests(c.input, SYSTEM_INSTRUCTIONS_SEGMENTER, onUsage), onLatency);
      const actual = normalizeSegmentResult(raw, c.input);
      return computeSegmentMetrics(c.expected.segments, actual);
    });
    const agg = aggregateSegment(results);
    return {
      operation: op,
      totalCases: cases.length,
      executedCases: agg.n,
      executionErrors: results.filter(r => r.executionError).map(r => ({ id: r.id, error: r.executionError! })),
      latency: latencyStats(results),
      meanCostUsdPerCall: meanCost(results),
      metrics: {
        segmentCountMatchRate: agg.segmentCountMatchRate,
        segmentExactMatchRate: agg.segmentExactMatchRate
      }
    };
  }

  // excel-mapping
  const cases = limitCases(loadJsonl<ExcelMappingCase>(DATASET_FILES[op]));
  const results = await runCasesWithCost(cases, candidate.model, async (c, onUsage, onLatency) => {
    const raw = await callWithRateLimitRetry(candidate.model, () => strategy.suggestExcelColumnMapping(c.input.headers, SYSTEM_INSTRUCTIONS_EXCEL_MAPPING, onUsage), onLatency);
    const actual = normalizeExcelMappingResult(raw);
    return computeExcelMappingMetrics(c.expected.mapping, actual);
  });
  const agg = aggregateExcelMapping(results);
  return {
    operation: op,
    totalCases: cases.length,
    executedCases: agg.n,
    executionErrors: results.filter(r => r.executionError).map(r => ({ id: r.id, error: r.executionError! })),
    latency: latencyStats(results),
    meanCostUsdPerCall: meanCost(results),
    metrics: { fieldAccuracy: agg.fieldAccuracy }
  };
}

// --- Reporte ---

interface ModelReport {
  label: string;
  model: string;
  operations: OperationComparisonResult[];
  // Una "búsqueda" real de producción hace 1 llamada de extract-intent + 1 de zone por segmento
  // (ver BE-09: hoy son 2 llamadas separadas) — segment/excel-mapping son flujos distintos, no se
  // sumsn acá. Si extract-intent o zone no corrieron (--op), queda en 0, no indefinido.
  costPerSearchUsd: number;
  costPer1000SearchesUsd: number;
}

function buildMarkdownReport(date: string, modelReports: ModelReport[]): string {
  const lines: string[] = [];
  lines.push(`# Comparativa de modelos — ${date}`);
  lines.push('');
  lines.push('Generado por `pnpm eval:compare-models` (evals/compare-models.ts, BE-46) — cada modelo');
  lines.push('corre AISLADO (sin el fallback de `AIExtractorContext`) contra los mismos datasets de');
  lines.push('`evals/`, para medir accuracy/latencia/costo por modelo sin que un fallo de uno se');
  lines.push('tape con el resultado del otro. Ver `docs/model-selection.md` para la tabla resumen y');
  lines.push('la decisión final.');
  lines.push('');

  for (const m of modelReports) {
    lines.push(`## ${m.label} (\`${m.model}\`)`);
    lines.push('');
    lines.push(`- **Costo estimado por búsqueda** (extract-intent + zone): $${m.costPerSearchUsd.toFixed(6)}`);
    lines.push(`- **Costo estimado por 1.000 búsquedas**: $${m.costPer1000SearchesUsd.toFixed(2)}`);
    lines.push('');

    for (const r of m.operations) {
      lines.push(`### ${r.operation}`);
      lines.push('');
      lines.push(`- Casos del dataset: ${r.totalCases}`);
      lines.push(`- Casos ejecutados sin error de infraestructura: ${r.executedCases}`);
      if (r.executionErrors.length > 0) {
        lines.push(`- Errores de ejecución (${r.executionErrors.length}): ${r.executionErrors.map(e => e.id).join(', ')}`);
      }
      lines.push(`- Latencia: p50 ${r.latency.p50}ms · p95 ${r.latency.p95}ms · media ${r.latency.meanMs.toFixed(0)}ms`);
      lines.push(`- Costo medio por llamada: $${r.meanCostUsdPerCall.toFixed(6)}`);
      lines.push('');
      lines.push('| Métrica | Valor |');
      lines.push('|---|---|');
      for (const [key, value] of Object.entries(r.metrics)) {
        lines.push(`| ${METRIC_LABELS[key] ?? key} | ${formatMetricValue(key, value)} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function parseListArg(args: string[], flag: string): string[] | null {
  const idx = args.findIndex(a => a === flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  return value ? value.split(',').map(s => s.trim()).filter(Boolean) : null;
}

function parseValueArg(args: string[], flag: string): string | null {
  const idx = args.findIndex(a => a === flag);
  return idx === -1 ? null : (args[idx + 1] ?? null);
}

async function main() {
  const args = process.argv.slice(2);

  // --max-cases: para modelos con cuota diaria de free tier escasa, no entra correr el dataset
  // completo en un solo día (ver dailyQuotaExhausted) — ver docs/model-selection.md para cómo se
  // usó esto en la corrida real.
  const maxCasesArg = parseValueArg(args, '--max-cases');
  const maxCasesPerOp = maxCasesArg !== null ? parseInt(maxCasesArg, 10) : undefined;
  if (maxCasesArg !== null && (!Number.isFinite(maxCasesPerOp) || (maxCasesPerOp as number) <= 0)) {
    console.error(`--max-cases inválido: "${maxCasesArg}"`);
    process.exitCode = 1;
    return;
  }

  // --out-suffix: nombre de archivo distinto para no pisar un reporte previo del mismo día (ej. al
  // correr una muestra reducida de un modelo por separado del resto).
  const outSuffix = parseValueArg(args, '--out-suffix') ?? '';

  const requestedOps = parseListArg(args, '--ops');
  if (requestedOps) {
    for (const op of requestedOps) {
      if (!ALL_OPERATIONS.includes(op as OperationName)) {
        console.error(`--ops inválido: "${op}". Valores válidos: ${ALL_OPERATIONS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
    }
  }
  const operations = (requestedOps as OperationName[] | null) ?? ALL_OPERATIONS;

  const requestedModels = parseListArg(args, '--models');
  const candidates = requestedModels
    ? CANDIDATES.filter(c => requestedModels.includes(c.model))
    : CANDIDATES;
  if (candidates.length === 0) {
    console.error(`--models no matcheó ningún candidato. Válidos: ${CANDIDATES.map(c => c.model).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const modelReports: ModelReport[] = [];
  for (const candidate of candidates) {
    console.log(`\n=== ${candidate.label} ===`);
    const operationResults: OperationComparisonResult[] = [];
    for (const op of operations) {
      console.log(`\n→ ${op}`);
      operationResults.push(await runOperationForStrategy(op, candidate, maxCasesPerOp));
    }
    const extractIntentCost = operationResults.find(r => r.operation === 'extract-intent')?.meanCostUsdPerCall ?? 0;
    const zoneCost = operationResults.find(r => r.operation === 'zone')?.meanCostUsdPerCall ?? 0;
    const costPerSearchUsd = extractIntentCost + zoneCost;
    modelReports.push({
      label: candidate.label,
      model: candidate.model,
      operations: operationResults,
      costPerSearchUsd,
      costPer1000SearchesUsd: costPerSearchUsd * 1000
    });
  }

  const date = new Date().toISOString().slice(0, 10);
  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const baseName = `${date}-model-comparison${outSuffix ? `-${outSuffix}` : ''}`;
  const markdown = buildMarkdownReport(date, modelReports);
  fs.writeFileSync(path.join(reportsDir, `${baseName}.md`), markdown, 'utf8');
  fs.writeFileSync(path.join(reportsDir, `${baseName}.json`), JSON.stringify({ date, modelReports }, null, 2), 'utf8');

  console.log(`\nReporte escrito en evals/reports/${baseName}.md y .json`);
}

main().catch(error => {
  console.error('Error fatal corriendo la comparativa de modelos:', error);
  process.exitCode = 1;
});
