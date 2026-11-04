// BE-46: extraído de run.ts (BE-02) para que evals/compare-models.ts (BE-46) reuse exactamente
// las mismas definiciones de dataset y cálculos de métricas sin duplicarlas — ambos scripts miden
// "lo mismo" contra la misma vara, solo cambia qué produce el `actual` de cada caso (el pipeline
// completo de ai.ts en run.ts, una única estrategia/modelo aislada en compare-models.ts).
import * as fs from 'fs';
import * as path from 'path';
import { ExtractedRealEstateRequest, ExcelColumnMappingSuggestion } from '../src/ai';

// --- Tipos de los datasets (ver evals/README.md) ---

export type OperationName = 'extract-intent' | 'zone' | 'segment' | 'excel-mapping';

export const ALL_OPERATIONS: OperationName[] = ['extract-intent', 'zone', 'segment', 'excel-mapping'];

export interface ExtractIntentCase {
  id: string;
  input: string;
  expected: ExtractedRealEstateRequest;
  tags: string[];
}

export interface ZoneCase {
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

// Shape mínimo de "actual" que necesita evalZoneCase — el pipeline completo (ai.ts) devuelve un
// ZoneIntentRequest ya resuelto contra la base (zona_ids/zona_nombres incluidos); una estrategia
// aislada (compare-models.ts) solo llega hasta acá (normalizeAgent2, sin resolveZoneIntent/DB) —
// ninguna de las métricas de esta operación mira zona_ids/zona_nombres, así que este shape alcanza
// para ambos casos.
export interface ZoneActualShape {
  texto_ubicacion_original: string;
  dormitorios_min: number | null;
  caracteristicas_claves: string[];
  operacion: 'ALQUILER' | 'COMPRA' | 'DESCONOCIDO';
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
  'extract-intent': 'extract-intent.jsonl',
  zone: 'zone.jsonl',
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

// --- extract-intent (Agente 1) ---

export interface ExtractIntentMetrics {
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

export function computeExtractIntentMetrics(e: ExtractedRealEstateRequest, actual: ExtractedRealEstateRequest): ExtractIntentMetrics {
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

export function aggregateExtractIntent(results: ExecutedCase<ExtractIntentMetrics>[]) {
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

export interface ZoneMetrics {
  ubicaciones: { precision: number; recall: number; exactMatch: boolean };
  dormitoriosMatch: boolean;
  caracteristicas: { precision: number; recall: number };
  operacionMatch: boolean;
  isDesconocida: boolean;
  expectedDesconocida: boolean;
}

export function computeZoneMetrics(e: ZoneCase['expected'], actual: ZoneActualShape): ZoneMetrics {
  const actualUbicaciones = actual.texto_ubicacion_original
    ? actual.texto_ubicacion_original.split(' | ').map(s => s.trim()).filter(s => s.length > 0)
    : [];
  return {
    ubicaciones: { ...precisionRecall(e.ubicaciones, actualUbicaciones), exactMatch: setExactMatch(e.ubicaciones, actualUbicaciones) },
    dormitoriosMatch: e.dormitorios_min === actual.dormitorios_min,
    caracteristicas: precisionRecall(e.caracteristicas_claves, actual.caracteristicas_claves),
    operacionMatch: e.operacion === actual.operacion,
    isDesconocida: actual.operacion === 'DESCONOCIDO',
    expectedDesconocida: e.operacion === 'DESCONOCIDO'
  };
}

export function aggregateZone(results: ExecutedCase<ZoneMetrics>[]) {
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

export function formatMetricValue(key: string, value: number): string {
  if (key === 'budgetMeanAbsError') return value.toFixed(0);
  return pct(value);
}
