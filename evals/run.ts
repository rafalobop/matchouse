// BE-02: eval runner — corre los datasets de evals/ (BE-01) contra la implementación REAL de
// src/services/ai.ts (llama a Gemini/OpenAI de verdad, no hay mocks) y escribe un reporte
// reproducible por campo, latencia y tasa de "no supo responder" (DESCONOCIDO/otro). Pensado para
// correr local (`pnpm eval`) y, más adelante, como gate de CI (BE-05).
//
// Tokens y costo USD/1.000 búsquedas (pedidos en el ticket original) NO se calculan todavía: las
// funciones públicas de ai.ts no devuelven usage metadata del proveedor (eso es instrumentación
// de tracing, alcance de BE-03/BE-04). El reporte deja la sección explícita como pendiente en vez
// de inventar un número.

import * as fs from 'fs';
import * as path from 'path';
import {
  extractFromTextInput,
  extractZoneIntent,
  segmentSearchRequests,
  suggestExcelColumnMapping,
  ExtractedRealEstateRequest,
  ZoneIntentRequest,
  ExcelColumnMappingSuggestion
} from '../src/services/ai';
import { config } from '../src/config/env';

// --- Tipos de los datasets (ver evals/README.md) ---

type OperationName = 'extract-intent' | 'zone' | 'segment' | 'excel-mapping';

const ALL_OPERATIONS: OperationName[] = ['extract-intent', 'zone', 'segment', 'excel-mapping'];

interface ExtractIntentCase {
  id: string;
  input: string;
  expected: ExtractedRealEstateRequest;
  tags: string[];
}

interface ZoneCase {
  id: string;
  input: string;
  operacion_hint: 'venta' | 'alquiler' | null;
  expected: {
    ubicaciones: string[];
    dormitorios_min: number | null;
    caracteristicas_claves: string[];
    operacion: 'ALQUILER' | 'COMPRA' | 'DESCONOCIDO';
  };
  tags: string[];
}

interface SegmentCase {
  id: string;
  input: string;
  expected: { segments: string[] };
  tags: string[];
}

interface ExcelMappingCase {
  id: string;
  input: { headers: string[] };
  expected: { mapping: { field: string; header: string | null }[] };
  tags: string[];
}

// --- Utilidades compartidas de métricas ---

function normalizeForSet(s: string): string {
  return s.trim().toLowerCase();
}

function precisionRecall(expected: string[], actual: string[]): { precision: number; recall: number } {
  const expSet = new Set(expected.map(normalizeForSet));
  const actSet = new Set(actual.map(normalizeForSet));
  if (expSet.size === 0 && actSet.size === 0) return { precision: 1, recall: 1 };
  let truePositives = 0;
  for (const item of actSet) {
    if (expSet.has(item)) truePositives++;
  }
  const precision = actSet.size === 0 ? (expSet.size === 0 ? 1 : 0) : truePositives / actSet.size;
  const recall = expSet.size === 0 ? (actSet.size === 0 ? 1 : 0) : truePositives / expSet.size;
  return { precision, recall };
}

function setExactMatch(expected: string[], actual: string[]): boolean {
  const expSet = new Set(expected.map(normalizeForSet));
  const actSet = new Set(actual.map(normalizeForSet));
  if (expSet.size !== actSet.size) return false;
  for (const item of expSet) {
    if (!actSet.has(item)) return false;
  }
  return true;
}

type NullableNumberComparison = { bothNull: true } | { nullMismatch: true } | { absError: number };

function compareNullableNumber(expected: number | null, actual: number | null): NullableNumberComparison {
  if (expected === null && actual === null) return { bothNull: true };
  if (expected === null || actual === null) return { nullMismatch: true };
  return { absError: Math.abs(expected - actual) };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// --- Carga de datasets ---

function loadJsonl<T>(fileName: string): T[] {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line, i) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`${fileName}:${i + 1} no es JSON válido: ${(error as Error).message}`);
    }
  });
}

// --- Resultado genérico de ejecutar un caso ---

interface ExecutedCase<TMetrics> {
  id: string;
  tags: string[];
  latencyMs: number;
  executionError?: string;
  metrics?: TMetrics;
}

async function runCases<TCase extends { id: string; tags: string[] }, TMetrics>(
  cases: TCase[],
  callAndEvaluate: (c: TCase) => Promise<TMetrics>
): Promise<ExecutedCase<TMetrics>[]> {
  const results: ExecutedCase<TMetrics>[] = [];
  for (const c of cases) {
    const start = Date.now();
    try {
      const metrics = await callAndEvaluate(c);
      results.push({ id: c.id, tags: c.tags, latencyMs: Date.now() - start, metrics });
    } catch (error) {
      results.push({ id: c.id, tags: c.tags, latencyMs: Date.now() - start, executionError: (error as Error).message });
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return results;
}

// --- extract-intent (Agente 1) ---

interface ExtractIntentMetrics {
  operationMatch: boolean;
  propertyTypeMatch: boolean;
  currencyMatch: boolean;
  countryMatch: boolean;
  bedroomsMatch: boolean;
  budget: NullableNumberComparison;
  zones: { precision: number; recall: number };
  keyFeatures: { precision: number; recall: number };
  isDesconocida: boolean;
  expectedDesconocida: boolean;
}

async function evalExtractIntentCase(c: ExtractIntentCase): Promise<ExtractIntentMetrics> {
  const actual = await extractFromTextInput(c.input);
  const e = c.expected;
  return {
    operationMatch: e.operation === actual.operation,
    propertyTypeMatch: e.property_type === actual.property_type,
    currencyMatch: e.currency === actual.currency,
    countryMatch: e.country === actual.country,
    bedroomsMatch: e.bedrooms === actual.bedrooms,
    budget: compareNullableNumber(e.max_budget, actual.max_budget),
    zones: precisionRecall(e.zones, actual.zones),
    keyFeatures: precisionRecall(e.key_features, actual.key_features),
    isDesconocida: actual.operation === 'desconocido' || actual.property_type === 'otro',
    expectedDesconocida: e.operation === 'desconocido' || e.property_type === 'otro'
  };
}

function aggregateExtractIntent(results: ExecutedCase<ExtractIntentMetrics>[]) {
  const ok = results.filter(r => r.metrics).map(r => r.metrics!);
  const n = ok.length;
  const absErrors = ok.map(m => m.budget).filter((b): b is { absError: number } => 'absError' in b).map(b => b.absError);
  const budgetNullMismatches = ok.filter(m => 'nullMismatch' in m.budget).length;
  const falseDesconocida = ok.filter(m => !m.expectedDesconocida && m.isDesconocida).length;
  return {
    n,
    operationMatchRate: rate(ok.filter(m => m.operationMatch).length, n),
    propertyTypeMatchRate: rate(ok.filter(m => m.propertyTypeMatch).length, n),
    currencyMatchRate: rate(ok.filter(m => m.currencyMatch).length, n),
    countryMatchRate: rate(ok.filter(m => m.countryMatch).length, n),
    bedroomsMatchRate: rate(ok.filter(m => m.bedroomsMatch).length, n),
    budgetMeanAbsError: mean(absErrors),
    budgetNullMismatchRate: rate(budgetNullMismatches, n),
    zonesPrecision: mean(ok.map(m => m.zones.precision)),
    zonesRecall: mean(ok.map(m => m.zones.recall)),
    keyFeaturesPrecision: mean(ok.map(m => m.keyFeatures.precision)),
    keyFeaturesRecall: mean(ok.map(m => m.keyFeatures.recall)),
    desconocidaRate: rate(ok.filter(m => m.isDesconocida).length, n),
    falseDesconocidaRate: rate(falseDesconocida, n)
  };
}

// --- zone (Agente 2) ---

interface ZoneMetrics {
  ubicaciones: { precision: number; recall: number; exactMatch: boolean };
  dormitoriosMatch: boolean;
  caracteristicas: { precision: number; recall: number };
  operacionMatch: boolean;
  isDesconocida: boolean;
  expectedDesconocida: boolean;
}

async function evalZoneCase(c: ZoneCase): Promise<ZoneMetrics> {
  const actual: ZoneIntentRequest = await extractZoneIntent(c.input, c.operacion_hint ?? undefined);
  const actualUbicaciones = actual.texto_ubicacion_original
    ? actual.texto_ubicacion_original.split(' | ').map(s => s.trim()).filter(s => s.length > 0)
    : [];
  const e = c.expected;
  return {
    ubicaciones: { ...precisionRecall(e.ubicaciones, actualUbicaciones), exactMatch: setExactMatch(e.ubicaciones, actualUbicaciones) },
    dormitoriosMatch: e.dormitorios_min === actual.dormitorios_min,
    caracteristicas: precisionRecall(e.caracteristicas_claves, actual.caracteristicas_claves),
    operacionMatch: e.operacion === actual.operacion,
    isDesconocida: actual.operacion === 'DESCONOCIDO',
    expectedDesconocida: e.operacion === 'DESCONOCIDO'
  };
}

function aggregateZone(results: ExecutedCase<ZoneMetrics>[]) {
  const ok = results.filter(r => r.metrics).map(r => r.metrics!);
  const n = ok.length;
  const falseDesconocida = ok.filter(m => !m.expectedDesconocida && m.isDesconocida).length;
  return {
    n,
    zonaCorrectaRate: rate(ok.filter(m => m.ubicaciones.exactMatch).length, n),
    zonaPrecision: mean(ok.map(m => m.ubicaciones.precision)),
    zonaRecall: mean(ok.map(m => m.ubicaciones.recall)),
    dormitoriosMatchRate: rate(ok.filter(m => m.dormitoriosMatch).length, n),
    caracteristicasPrecision: mean(ok.map(m => m.caracteristicas.precision)),
    caracteristicasRecall: mean(ok.map(m => m.caracteristicas.recall)),
    operacionMatchRate: rate(ok.filter(m => m.operacionMatch).length, n),
    desconocidaRate: rate(ok.filter(m => m.isDesconocida).length, n),
    falseDesconocidaRate: rate(falseDesconocida, n)
  };
}

// --- segment (Agente 0) ---

interface SegmentMetrics {
  countMatch: boolean;
  exactMatch: boolean;
}

async function evalSegmentCase(c: SegmentCase): Promise<SegmentMetrics> {
  const actual = await segmentSearchRequests(c.input);
  const countMatch = c.expected.segments.length === actual.length;
  const exactMatch = countMatch && c.expected.segments.every((s, i) => s.trim() === (actual[i] ?? '').trim());
  return { countMatch, exactMatch };
}

function aggregateSegment(results: ExecutedCase<SegmentMetrics>[]) {
  const ok = results.filter(r => r.metrics).map(r => r.metrics!);
  const n = ok.length;
  return {
    n,
    segmentCountMatchRate: rate(ok.filter(m => m.countMatch).length, n),
    segmentExactMatchRate: rate(ok.filter(m => m.exactMatch).length, n)
  };
}

// --- excel-mapping ---

interface ExcelMappingMetrics {
  matches: number;
  total: number;
}

async function evalExcelMappingCase(c: ExcelMappingCase): Promise<ExcelMappingMetrics> {
  const actual: ExcelColumnMappingSuggestion[] = await suggestExcelColumnMapping(c.input.headers);
  let matches = 0;
  for (const exp of c.expected.mapping) {
    const act = actual.find(a => a.field === exp.field);
    const actualHeader = act ? act.header : null;
    if (actualHeader === exp.header) matches++;
  }
  return { matches, total: c.expected.mapping.length };
}

function aggregateExcelMapping(results: ExecutedCase<ExcelMappingMetrics>[]) {
  const ok = results.filter(r => r.metrics).map(r => r.metrics!);
  const n = ok.length;
  const totalFields = ok.reduce((a, m) => a + m.total, 0);
  const totalMatches = ok.reduce((a, m) => a + m.matches, 0);
  return {
    n,
    fieldAccuracy: rate(totalMatches, totalFields)
  };
}

// --- Reporte ---

interface OperationReport {
  operation: OperationName;
  totalCases: number;
  executedCases: number;
  executionErrors: { id: string; error: string }[];
  criticalFailure: boolean;
  latency: { p50: number; p95: number; meanMs: number };
  metrics: Record<string, number>;
}

function latencyStats(results: ExecutedCase<unknown>[]) {
  const latencies = results.filter(r => !r.executionError).map(r => r.latencyMs).sort((a, b) => a - b);
  return { p50: percentile(latencies, 50), p95: percentile(latencies, 95), meanMs: mean(latencies) };
}

async function runOperation(op: OperationName): Promise<OperationReport> {
  console.log(`\n→ ${op}`);

  if (op === 'extract-intent') {
    const cases = loadJsonl<ExtractIntentCase>('extract-intent.jsonl');
    const results = await runCases(cases, evalExtractIntentCase);
    const agg = aggregateExtractIntent(results);
    const executionErrors = results.filter(r => r.executionError).map(r => ({ id: r.id, error: r.executionError! }));
    return {
      operation: op,
      totalCases: cases.length,
      executedCases: agg.n,
      executionErrors,
      criticalFailure: cases.length > 0 && agg.n === 0,
      latency: latencyStats(results),
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
    const cases = loadJsonl<ZoneCase>('zone.jsonl');
    const results = await runCases(cases, evalZoneCase);
    const agg = aggregateZone(results);
    const executionErrors = results.filter(r => r.executionError).map(r => ({ id: r.id, error: r.executionError! }));
    return {
      operation: op,
      totalCases: cases.length,
      executedCases: agg.n,
      executionErrors,
      criticalFailure: cases.length > 0 && agg.n === 0,
      latency: latencyStats(results),
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
    const cases = loadJsonl<SegmentCase>('segment.jsonl');
    const results = await runCases(cases, evalSegmentCase);
    const agg = aggregateSegment(results);
    const executionErrors = results.filter(r => r.executionError).map(r => ({ id: r.id, error: r.executionError! }));
    return {
      operation: op,
      totalCases: cases.length,
      executedCases: agg.n,
      executionErrors,
      criticalFailure: cases.length > 0 && agg.n === 0,
      latency: latencyStats(results),
      metrics: {
        segmentCountMatchRate: agg.segmentCountMatchRate,
        segmentExactMatchRate: agg.segmentExactMatchRate
      }
    };
  }

  // excel-mapping
  const cases = loadJsonl<ExcelMappingCase>('excel-mapping.jsonl');
  const results = await runCases(cases, evalExcelMappingCase);
  const agg = aggregateExcelMapping(results);
  const executionErrors = results.filter(r => r.executionError).map(r => ({ id: r.id, error: r.executionError! }));
  return {
    operation: op,
    totalCases: cases.length,
    executedCases: agg.n,
    executionErrors,
    criticalFailure: cases.length > 0 && agg.n === 0,
    latency: latencyStats(results),
    metrics: {
      fieldAccuracy: agg.fieldAccuracy
    }
  };
}

const METRIC_LABELS: Record<string, string> = {
  operationMatchRate: 'operation (exact match)',
  propertyTypeMatchRate: 'property_type (exact match)',
  currencyMatchRate: 'currency (exact match)',
  countryMatchRate: 'country (exact match)',
  bedroomsMatchRate: 'bedrooms (exact match)',
  budgetMeanAbsError: 'max_budget (error absoluto medio)',
  budgetNullMismatchRate: 'max_budget (null vs. no-null, tasa de error)',
  zonesPrecision: 'zones (precision)',
  zonesRecall: 'zones (recall)',
  keyFeaturesPrecision: 'key_features (precision)',
  keyFeaturesRecall: 'key_features (recall)',
  desconocidaRate: 'tasa de DESCONOCIDA/otro',
  falseDesconocidaRate: 'tasa de DESCONOCIDA falsa (esperado != desconocido)',
  zonaCorrectaRate: 'zona correcta (set exacto de ubicaciones)',
  zonaPrecision: 'ubicaciones (precision)',
  zonaRecall: 'ubicaciones (recall)',
  dormitoriosMatchRate: 'dormitorios_min (exact match)',
  caracteristicasPrecision: 'caracteristicas_claves (precision)',
  caracteristicasRecall: 'caracteristicas_claves (recall)',
  operacionMatchRate: 'operacion (exact match)',
  segmentCountMatchRate: 'cantidad de segmentos correcta',
  segmentExactMatchRate: 'segmentos exactamente iguales (texto)',
  fieldAccuracy: 'mapeo field→header (accuracy sobre los 11 campos)'
};

function formatMetricValue(key: string, value: number): string {
  if (key === 'budgetMeanAbsError') return value.toFixed(0);
  return pct(value);
}

function buildMarkdownReport(date: string, reports: OperationReport[]): string {
  const lines: string[] = [];
  lines.push(`# Reporte de evals — ${date}`);
  lines.push('');
  lines.push('Generado por `pnpm eval` (evals/run.ts, BE-02) contra la implementación real de');
  lines.push('`src/services/ai.ts` — sin mocks, llamadas reales a los proveedores de IA configurados.');
  lines.push('');
  lines.push('**Tokens y costo USD/1.000 búsquedas:** no disponibles todavía — `ai.ts` no expone usage');
  lines.push('metadata del proveedor en sus funciones públicas. Queda pendiente de BE-03/BE-04');
  lines.push('(tracing/persistencia de métricas por llamada LLM).');
  lines.push('');

  for (const r of reports) {
    lines.push(`## ${r.operation}`);
    lines.push('');
    lines.push(`- Casos del dataset: ${r.totalCases}`);
    lines.push(`- Casos ejecutados sin error de infraestructura: ${r.executedCases}`);
    if (r.criticalFailure) {
      lines.push(`- ⚠️ **FALLA CRÍTICA**: ninguno de los ${r.totalCases} casos pudo ejecutarse.`);
    }
    if (r.executionErrors.length > 0) {
      lines.push(`- Errores de ejecución (${r.executionErrors.length}): ${r.executionErrors.map(e => e.id).join(', ')}`);
    }
    lines.push(`- Latencia: p50 ${r.latency.p50}ms · p95 ${r.latency.p95}ms · media ${r.latency.meanMs.toFixed(0)}ms`);
    lines.push('');
    lines.push('| Métrica | Valor |');
    lines.push('|---|---|');
    for (const [key, value] of Object.entries(r.metrics)) {
      lines.push(`| ${METRIC_LABELS[key] ?? key} | ${formatMetricValue(key, value)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  let requestedOp: OperationName | null = null;
  const opIndex = args.findIndex(a => a === '--op');
  if (opIndex !== -1) {
    const value = args[opIndex + 1];
    if (!ALL_OPERATIONS.includes(value as OperationName)) {
      console.error(`--op inválido: "${value}". Valores válidos: ${ALL_OPERATIONS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    requestedOp = value as OperationName;
  } else {
    const inlineFlag = args.find(a => a.startsWith('--op='));
    if (inlineFlag) {
      const value = inlineFlag.split('=')[1];
      if (!ALL_OPERATIONS.includes(value as OperationName)) {
        console.error(`--op inválido: "${value}". Valores válidos: ${ALL_OPERATIONS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      requestedOp = value as OperationName;
    }
  }

  // BE-01's extract-intent.jsonl ejercita extractFromTextInput (KAN-36), que rechaza si el flag
  // está apagado — el eval mide la calidad de la extracción, no el flag de feature, así que se
  // fuerza habilitado para esta corrida sin importar el .env.
  config.freeTextExtractionEnabled = true;

  const operations = requestedOp ? [requestedOp] : ALL_OPERATIONS;
  console.log(`Corriendo evals para: ${operations.join(', ')}`);

  const reports: OperationReport[] = [];
  for (const op of operations) {
    reports.push(await runOperation(op));
  }

  const date = new Date().toISOString().slice(0, 10);
  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const markdown = buildMarkdownReport(date, reports);
  fs.writeFileSync(path.join(reportsDir, `${date}.md`), markdown, 'utf8');
  fs.writeFileSync(path.join(reportsDir, `${date}.json`), JSON.stringify({ date, reports }, null, 2), 'utf8');

  console.log(`\nReporte escrito en evals/reports/${date}.md y ${date}.json`);

  const anyCriticalFailure = reports.some(r => r.criticalFailure);
  if (anyCriticalFailure) {
    console.error('\nAl menos una operación no pudo ejecutar ningún caso. Ver el reporte para detalle.');
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Error fatal corriendo evals:', error);
  process.exitCode = 1;
});
