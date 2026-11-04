// BE-46: extraído de run.ts (BE-02) para que evals/compare-models.ts (BE-46) reuse exactamente
// las mismas definiciones de dataset y cálculos de métricas sin duplicarlas — ambos scripts miden
// "lo mismo" contra la misma vara, solo cambia qué produce el `actual` de cada caso (el pipeline
// completo de src/ai/ en run.ts, una única estrategia/modelo aislada en compare-models.ts).
//
// BE-09: 'extract-intent' y 'zone' se consolidan en una sola operación 'search-intent' — antes
// eran dos llamadas LLM separadas (Agente 1 + Agente 2) con datasets de INPUTS DISTINTOS
// (extract-intent.jsonl probaba textos completos, zone.jsonl probaba fragmentos más cortos con un
// `operacion_hint` simulando la salida de Agente 1). Con una sola llamada ya no hay ningún
// `operacion_hint` que simular ni una resolución de zona que testear por separado de la
// extracción — `evals/search-intent.jsonl` (nuevo, dataset curado a mano, no un merge mecánico de
// los 108 casos viejos) reemplaza a ambos. `extract-intent.jsonl`/`zone.jsonl` quedan en el repo
// como artefactos históricos del esquema de dos agentes, sin consumidor real (ver evals/README.md).
import * as fs from 'fs';
import * as path from 'path';
import { SearchIntent, ExcelColumnMappingSuggestion } from '../src/ai';

// --- Tipos de los datasets (ver evals/README.md) ---

export type OperationName = 'search-intent' | 'segment' | 'excel-mapping';

export const ALL_OPERATIONS: OperationName[] = ['search-intent', 'segment', 'excel-mapping'];

export interface SearchIntentCase {
  id: string;
  input: string;
  expected: SearchIntent;
  tags: string[];
}

export interface SegmentCase {
  id: string;
  input: string;
  expected: { segments: string[] };
  tags: string[];
}

export interface ExcelMappingCase {
  id: string;
  input: { headers: string[] };
  expected: { mapping: { field: string; header: string | null }[] };
  tags: string[];
}

// --- Utilidades compartidas de métricas ---

export function normalizeForSet(s: string): string {
  return s.trim().toLowerCase();
}

export function precisionRecall(expected: string[], actual: string[]): { precision: number; recall: number } {
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

export function setExactMatch(expected: string[], actual: string[]): boolean {
  const expSet = new Set(expected.map(normalizeForSet));
  const actSet = new Set(actual.map(normalizeForSet));
  if (expSet.size !== actSet.size) return false;
  for (const item of expSet) {
    if (!actSet.has(item)) return false;
  }
  return true;
}

export type NullableNumberComparison = { bothNull: true } | { nullMismatch: true } | { absError: number };

export function compareNullableNumber(expected: number | null, actual: number | null): NullableNumberComparison {
  if (expected === null && actual === null) return { bothNull: true };
  if (expected === null || actual === null) return { nullMismatch: true };
  return { absError: Math.abs(expected - actual) };
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// --- Carga de datasets ---

export function loadJsonl<T>(fileName: string): T[] {
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

export const DATASET_FILES: Record<OperationName, string> = {
  'search-intent': 'search-intent.jsonl',
  segment: 'segment.jsonl',
  'excel-mapping': 'excel-mapping.jsonl'
};

// --- Resultado genérico de ejecutar un caso ---

export interface ExecutedCase<TMetrics> {
  id: string;
  tags: string[];
  latencyMs: number;
  executionError?: string;
  metrics?: TMetrics;
}

export async function runCases<TCase extends { id: string; tags: string[] }, TMetrics>(
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

export function latencyStats(results: ExecutedCase<unknown>[]) {
  const latencies = results.filter(r => !r.executionError).map(r => r.latencyMs).sort((a, b) => a - b);
  return { p50: percentile(latencies, 50), p95: percentile(latencies, 95), meanMs: mean(latencies) };
}

// --- search-intent (BE-09: Agente 1 + Agente 2 fusionados) ---

export interface SearchIntentMetrics {
  operationMatch: boolean;
  propertyTypeMatch: boolean;
  currencyMatch: boolean;
  countryMatch: boolean;
  bedroomsMinMatch: boolean;
  budget: NullableNumberComparison;
  locationMentions: { precision: number; recall: number };
  features: { precision: number; recall: number };
  isDesconocida: boolean;
  expectedDesconocida: boolean;
}

export function computeSearchIntentMetrics(e: SearchIntent, actual: SearchIntent): SearchIntentMetrics {
  return {
    operationMatch: e.operation === actual.operation,
    propertyTypeMatch: e.property_type === actual.property_type,
    currencyMatch: e.currency === actual.currency,
    countryMatch: e.country === actual.country,
    bedroomsMinMatch: e.bedrooms_min === actual.bedrooms_min,
    budget: compareNullableNumber(e.max_budget, actual.max_budget),
    locationMentions: precisionRecall(e.location_mentions, actual.location_mentions),
    features: precisionRecall(e.features, actual.features),
    isDesconocida: actual.operation === 'desconocido' || actual.property_type === 'otro',
    expectedDesconocida: e.operation === 'desconocido' || e.property_type === 'otro'
  };
}

export function aggregateSearchIntent(results: ExecutedCase<SearchIntentMetrics>[]) {
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
    bedroomsMinMatchRate: rate(ok.filter(m => m.bedroomsMinMatch).length, n),
    budgetMeanAbsError: mean(absErrors),
    budgetNullMismatchRate: rate(budgetNullMismatches, n),
    locationMentionsPrecision: mean(ok.map(m => m.locationMentions.precision)),
    locationMentionsRecall: mean(ok.map(m => m.locationMentions.recall)),
    featuresPrecision: mean(ok.map(m => m.features.precision)),
    featuresRecall: mean(ok.map(m => m.features.recall)),
    desconocidaRate: rate(ok.filter(m => m.isDesconocida).length, n),
    falseDesconocidaRate: rate(falseDesconocida, n)
  };
}

// --- segment (Agente 0) ---

export interface SegmentMetrics {
  countMatch: boolean;
  exactMatch: boolean;
}

export function computeSegmentMetrics(expectedSegments: string[], actual: string[]): SegmentMetrics {
  const countMatch = expectedSegments.length === actual.length;
  const exactMatch = countMatch && expectedSegments.every((s, i) => s.trim() === (actual[i] ?? '').trim());
  return { countMatch, exactMatch };
}

export function aggregateSegment(results: ExecutedCase<SegmentMetrics>[]) {
  const ok = results.filter(r => r.metrics).map(r => r.metrics!);
  const n = ok.length;
  return {
    n,
    segmentCountMatchRate: rate(ok.filter(m => m.countMatch).length, n),
    segmentExactMatchRate: rate(ok.filter(m => m.exactMatch).length, n)
  };
}

// --- excel-mapping ---

export interface ExcelMappingMetrics {
  matches: number;
  total: number;
}

export function computeExcelMappingMetrics(expectedMapping: { field: string; header: string | null }[], actual: ExcelColumnMappingSuggestion[]): ExcelMappingMetrics {
  let matches = 0;
  for (const exp of expectedMapping) {
    const act = actual.find(a => a.field === exp.field);
    const actualHeader = act ? act.header : null;
    if (actualHeader === exp.header) matches++;
  }
  return { matches, total: expectedMapping.length };
}

export function aggregateExcelMapping(results: ExecutedCase<ExcelMappingMetrics>[]) {
  const ok = results.filter(r => r.metrics).map(r => r.metrics!);
  const n = ok.length;
  const totalFields = ok.reduce((a, m) => a + m.total, 0);
  const totalMatches = ok.reduce((a, m) => a + m.matches, 0);
  return {
    n,
    fieldAccuracy: rate(totalMatches, totalFields)
  };
}

// --- Etiquetas de métricas para reportes en Markdown ---

export const METRIC_LABELS: Record<string, string> = {
  operationMatchRate: 'operation (exact match)',
  propertyTypeMatchRate: 'property_type (exact match)',
  currencyMatchRate: 'currency (exact match)',
  countryMatchRate: 'country (exact match)',
  bedroomsMinMatchRate: 'bedrooms_min (exact match)',
  budgetMeanAbsError: 'max_budget (error absoluto medio)',
  budgetNullMismatchRate: 'max_budget (null vs. no-null, tasa de error)',
  locationMentionsPrecision: 'location_mentions (precision)',
  locationMentionsRecall: 'location_mentions (recall)',
  featuresPrecision: 'features (precision)',
  featuresRecall: 'features (recall)',
  desconocidaRate: 'tasa de DESCONOCIDA/otro',
  falseDesconocidaRate: 'tasa de DESCONOCIDA falsa (esperado != desconocido)',
  segmentCountMatchRate: 'cantidad de segmentos correcta',
  segmentExactMatchRate: 'segmentos exactamente iguales (texto)',
  fieldAccuracy: 'mapeo field→header (accuracy sobre los 11 campos)'
};

export function formatMetricValue(key: string, value: number): string {
  if (key === 'budgetMeanAbsError') return value.toFixed(0);
  return pct(value);
}
