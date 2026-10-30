// BE-02: eval runner — corre los datasets de evals/ (BE-01) contra la implementación REAL de
// src/services/ai.ts (llama a Gemini/OpenAI de verdad, no hay mocks) y escribe un reporte
// reproducible por campo, latencia y tasa de "no supo responder" (DESCONOCIDO/otro). Pensado para
// correr local (`pnpm eval`) y, más adelante, como gate de CI (BE-05).
//
// BE-46: las definiciones de dataset y las funciones de métricas/agregación viven ahora en
// evals/metrics.ts — este archivo solo orquesta: llama al pipeline completo de ai.ts (con
// fallback Gemini→OpenAI, como en producción) y arma el reporte. evals/compare-models.ts reusa el
// mismo módulo de métricas para aislar un único modelo por vez.
//
// Tokens y costo USD/1.000 búsquedas: desde BE-03/BE-04, extractFromTextInput/extractZoneIntent/
// segmentSearchRequests/suggestExcelColumnMapping ya persisten cada llamada real en la tabla
// llm_calls (tenant_id/search_id quedan null acá, al no venir de un request real) — el costo de
// ESTE pipeline (con fallback) se puede consultar ahí. La comparativa aislada por modelo (BE-46)
// vive en evals/compare-models.ts y docs/model-selection.md.

import * as fs from 'fs';
import * as path from 'path';
import {
  extractFromTextInput,
  extractZoneIntent,
  segmentSearchRequests,
  suggestExcelColumnMapping,
  ZoneIntentRequest
} from '../src/services/ai';
import { config } from '../src/config/env';
import {
  ALL_OPERATIONS,
  OperationName,
  ExtractIntentCase,
  ZoneCase,
  SegmentCase,
  ExcelMappingCase,
  DATASET_FILES,
  loadJsonl,
  runCases,
  latencyStats,
  computeExtractIntentMetrics,
  aggregateExtractIntent,
  computeZoneMetrics,
  aggregateZone,
  computeSegmentMetrics,
  aggregateSegment,
  computeExcelMappingMetrics,
  aggregateExcelMapping,
  METRIC_LABELS,
  formatMetricValue
} from './metrics';

// --- Llamadas al pipeline completo (con fallback) por operación ---

async function evalExtractIntentCase(c: ExtractIntentCase) {
  const actual = await extractFromTextInput(c.input);
  return computeExtractIntentMetrics(c.expected, actual);
}

async function evalZoneCase(c: ZoneCase) {
  const actual: ZoneIntentRequest = await extractZoneIntent(c.input, c.operacion_hint ?? undefined);
  return computeZoneMetrics(c.expected, actual);
}

async function evalSegmentCase(c: SegmentCase) {
  const actual = await segmentSearchRequests(c.input);
  return computeSegmentMetrics(c.expected.segments, actual);
}

async function evalExcelMappingCase(c: ExcelMappingCase) {
  const actual = await suggestExcelColumnMapping(c.input.headers);
  return computeExcelMappingMetrics(c.expected.mapping, actual);
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

// BE-05: maxCasesPerOp acota cuántos casos de cada dataset se corren — el eval gate de CI
// (.github/workflows/eval-gate.yml) lo usa para no quemar la cuota diaria de Gemini en cada PR
// (ver BE-46: el free tier tiene un cap de 20 requests/día POR MODELO, no solo por minuto).
// undefined = dataset completo (uso normal de `pnpm eval` local).
async function runOperation(op: OperationName, maxCasesPerOp?: number): Promise<OperationReport> {
  console.log(`\n→ ${op}`);
  const limitCases = <T,>(all: T[]): T[] => (maxCasesPerOp !== undefined ? all.slice(0, maxCasesPerOp) : all);

  if (op === 'extract-intent') {
    const cases = limitCases(loadJsonl<ExtractIntentCase>(DATASET_FILES[op]));
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
    const cases = limitCases(loadJsonl<ZoneCase>(DATASET_FILES[op]));
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
    const cases = limitCases(loadJsonl<SegmentCase>(DATASET_FILES[op]));
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
  const cases = limitCases(loadJsonl<ExcelMappingCase>(DATASET_FILES[op]));
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

function buildMarkdownReport(date: string, reports: OperationReport[]): string {
  const lines: string[] = [];
  lines.push(`# Reporte de evals — ${date}`);
  lines.push('');
  lines.push('Generado por `pnpm eval` (evals/run.ts, BE-02) contra la implementación real de');
  lines.push('`src/services/ai.ts` — sin mocks, llamadas reales a los proveedores de IA configurados');
  lines.push('(pipeline completo con fallback Gemini→OpenAI, como en producción).');
  lines.push('');
  lines.push('**Costo/tokens de ESTE pipeline (con fallback):** cada llamada queda persistida en la');
  lines.push('tabla `llm_calls` (BE-04), con `tenant_id`/`search_id` null por no venir de un request');
  lines.push('real. **Comparativa aislada de 3 modelos** (sin fallback, accuracy × costo × latencia):');
  lines.push('ver `evals/compare-models.ts` y `docs/model-selection.md` (BE-46).');
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

  // BE-05: --max-cases <n> acota el dataset (ver runOperation) y --out-dir <path> escribe el
  // reporte en otro lado que evals/reports/ — ambos pensados para el eval gate de CI, que no debe
  // ni gastar el dataset completo (cuota diaria de Gemini, ver BE-46) ni pisar un baseline
  // commiteado del mismo día.
  const maxCasesIdx = args.findIndex(a => a === '--max-cases');
  const maxCasesPerOp = maxCasesIdx !== -1 ? parseInt(args[maxCasesIdx + 1], 10) : undefined;
  if (maxCasesIdx !== -1 && (!Number.isFinite(maxCasesPerOp) || (maxCasesPerOp as number) <= 0)) {
    console.error(`--max-cases inválido: "${args[maxCasesIdx + 1]}"`);
    process.exitCode = 1;
    return;
  }
  const outDirIdx = args.findIndex(a => a === '--out-dir');
  const outDir = outDirIdx !== -1 ? args[outDirIdx + 1] : null;

  // BE-01's extract-intent.jsonl ejercita extractFromTextInput (KAN-36), que rechaza si el flag
  // está apagado — el eval mide la calidad de la extracción, no el flag de feature, así que se
  // fuerza habilitado para esta corrida sin importar el .env.
  config.freeTextExtractionEnabled = true;

  const operations = requestedOp ? [requestedOp] : ALL_OPERATIONS;
  console.log(`Corriendo evals para: ${operations.join(', ')}${maxCasesPerOp ? ` (máx. ${maxCasesPerOp} casos/operación)` : ''}`);

  const reports: OperationReport[] = [];
  for (const op of operations) {
    reports.push(await runOperation(op, maxCasesPerOp));
  }

  const date = new Date().toISOString().slice(0, 10);
  const reportsDir = outDir ? path.resolve(outDir) : path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const markdown = buildMarkdownReport(date, reports);
  fs.writeFileSync(path.join(reportsDir, `${date}.md`), markdown, 'utf8');
  fs.writeFileSync(path.join(reportsDir, `${date}.json`), JSON.stringify({ date, reports }, null, 2), 'utf8');

  console.log(`\nReporte escrito en ${path.join(reportsDir, `${date}.md`)} y ${date}.json`);

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
