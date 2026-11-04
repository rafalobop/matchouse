// BE-06/BE-09: punto de entrada público de la capa de IA. La estructura real vive en:
//   schemas/    — un schema Zod por operación (fuente única de verdad del contrato de salida)
//   providers/  — GeminiProvider/OpenAIProvider (implementan LLMProvider.generateStructured) y
//                 FallbackProvider (orquesta el fallback + tracing + métricas, una sola vez)
//   operations/ — las 3 funciones de negocio (extractSearchIntent, segmentSearchRequests,
//                 suggestExcelColumnMapping), ~20-120 líneas cada una
//   prompts.ts  — los SYSTEM_INSTRUCTIONS_* (sin versionar todavía — eso es BE-08)
//
// BE-09: extractSearchIntent reemplaza a extractFromTextInput + extractZoneIntent (Agente 1 +
// Agente 2 fusionados en una sola llamada LLM por segmento — ver operations/extractSearchIntent.ts
// para el detalle completo de la fusión).
//
// Las funciones exportadas acá SON declaraciones propias (no `export { x } from './y'`) a
// propósito: varios tests (`tests/searchController.test.ts`, `tests/searchSegmentProcessor.test.ts`,
// `tests/kan303IncomingMatchHighlight.test.ts`) hacen `t.mock.method(aiService, 'extractSearchIntent', ...)`
// sobre `import * as aiService from '.../ai'` — verificado con un repro real: `t.mock.method`
// lee el descriptor crudo de la propiedad (`value`), no invoca getters, así que una propiedad
// re-exportada (que TypeScript compila como `Object.defineProperty(exports, 'x', { get: ... })`,
// sin `value`) hace que `t.mock.method` falle con "'methodName' must be a method. Received
// undefined". Una función propia (`exports.x = function...`) es un valor real y sí es mockeable
// — por eso cada operación tiene un wrapper acá, no un re-export directo.
import { config } from '../config/env';
import { logger } from '../services/logger';
import { FallbackProvider } from './providers/fallbackProvider';
import { GeminiProvider } from './providers/geminiProvider';
import { OpenAIProvider } from './providers/openaiProvider';
import type { LLMProvider } from './providers/types';
import { extractSearchIntent as extractSearchIntentImpl, SearchIntentResult } from './operations/extractSearchIntent';
import { segmentSearchRequests as segmentSearchRequestsImpl } from './operations/segment';
import { suggestExcelColumnMapping as suggestExcelColumnMappingImpl } from './operations/excelMapping';

// Mismo orden de prioridades que el ai.ts viejo (AIExtractorContext): Gemini primero, OpenAI como
// fallback si está configurada. Singleton a nivel de módulo — quitar esto (inyección de
// dependencias real en los casos de uso) es BE-14, bloqueado por BE-06.
const providers: LLMProvider[] = [new GeminiProvider()];
if (config.openaiApiKey) {
  providers.push(new OpenAIProvider());
} else {
  logger.warn('[AI] OpenAI no está disponible (falta OPENAI_API_KEY).');
}
const fallbackProvider = new FallbackProvider(providers);

// BE-09: una sola llamada LLM por segmento (antes: extractFromTextInput + extractZoneIntent en
// serie). Detrás de FREE_TEXT_EXTRACTION_ENABLED lo sigue estando — ver operations/extractSearchIntent.ts.
export async function extractSearchIntent(freeText: string, tenantId?: string): Promise<SearchIntentResult> {
  return extractSearchIntentImpl(fallbackProvider, freeText, tenantId);
}

// Agente 0: divide un mensaje en N pedidos de búsqueda independientes. Fail-soft — nunca lanza,
// degrada a `[freeText]` (mensaje completo como única búsqueda) ante cualquier fallo.
export async function segmentSearchRequests(freeText: string, tenantId?: string): Promise<string[]> {
  return segmentSearchRequestsImpl(fallbackProvider, freeText, tenantId);
}

// KAN-84: usado por excelMapping.ts cuando la heurística de keywords no resuelve los campos
// requeridos con confianza suficiente. Nunca lanza — un fallo total de IA devuelve `[]`.
export async function suggestExcelColumnMapping(headers: string[], tenantId?: string): Promise<import('./schemas/excelMapping.schema').ExcelColumnMappingSuggestion[]> {
  return suggestExcelColumnMappingImpl(fallbackProvider, headers, tenantId);
}

// --- Tipos y errores públicos (re-exports simples: clases/tipos, nunca mockeados como método) ---
export type { SearchIntent } from './schemas/searchIntent.schema';
export type { SearchIntentResult } from './operations/extractSearchIntent';
export type { ZoneStatus, ZoneIntentRequest } from './schemas/zoneIntent.schema';
export type { ExcelColumnMappingSuggestion } from './schemas/excelMapping.schema';
export { AITimeoutError, AIExtractionFailedError } from './operations/extractSearchIntent';

// --- Providers y abstracción de fallback (para tests de bajo nivel y evals/compare-models.ts) ---
export { GeminiProvider } from './providers/geminiProvider';
export { OpenAIProvider } from './providers/openaiProvider';
export { FallbackProvider } from './providers/fallbackProvider';
export { AllProvidersFailedError, SchemaValidationError } from './providers/types';
export type { LLMProvider, GenerateStructuredParams, GenerateStructuredResult } from './providers/types';

// --- Schemas Zod (para evals/compare-models.ts, que valida contra el mismo contrato) ---
export { SearchIntentSchema } from './schemas/searchIntent.schema';
export { SegmentSchema } from './schemas/segment.schema';
export { ExcelMappingSchema } from './schemas/excelMapping.schema';

// --- Prompts (para evals/compare-models.ts, que arma las mismas llamadas aisladas) ---
export { SYSTEM_INSTRUCTIONS_SEARCH_INTENT, SYSTEM_INSTRUCTIONS_SEGMENTER, SYSTEM_INSTRUCTIONS_EXCEL_MAPPING } from './prompts';

// --- Normalización de negocio post-schema, reusada por evals/compare-models.ts (BE-46) ---
export { toSegments } from './operations/segment';

// --- Observabilidad (setter de test, ver observability.ts) ---
export { __setLlmCallsClientForTests } from './observability';
