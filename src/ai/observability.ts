import { logger } from '../services/logger';
import { recordLlmCall } from '../services/llmCallsRepository';
import { estimateCostUsd } from '../config/modelPricing';
import { supabase, TypedSupabaseClient } from '../services/supabase';

// BE-06: movido tal cual del ai.ts viejo (mismo comportamiento, mismo bug ya corregido por QA en
// BE-04) — ver ese historial para el contexto completo del hallazgo: tests/ai.test.ts ejercitaba
// AIExtractorContext real, y sin este seam de inyección, persistLlmCall usaba el singleton real de
// Supabase y contaminaba la tabla de producción en cada corrida de `pnpm test`.
let llmCallsClient: TypedSupabaseClient = supabase;

/** Permite inyectar un cliente fake en tests para no escribir en la base real. */
export function __setLlmCallsClientForTests(client: TypedSupabaseClient): void {
  llmCallsClient = client;
}

// BE-04: inserta una fila en llm_calls por cada llamada real a un proveedor de IA, con el mismo
// costo estimado que ya calcula tracing.ts para el span de Langfuse (ver config/modelPricing.ts).
// Fire-and-forget (no se awaitea desde los call sites) — mismo criterio best-effort que
// recordLlmGeneration, nunca debe poder demorar ni romper una extracción ya resuelta.
export function persistLlmCall(params: {
  operation: string;
  model: string;
  promptVersion: string;
  usage?: { inputTokens: number; outputTokens: number };
  startTime: Date;
  fallbackUsed: boolean;
  schemaValid: boolean;
  tenantId?: string;
}): void {
  void recordLlmCall(llmCallsClient, {
    operation: params.operation,
    model: params.model,
    promptVersion: params.promptVersion,
    tokensIn: params.usage?.inputTokens ?? 0,
    tokensOut: params.usage?.outputTokens ?? 0,
    latencyMs: Date.now() - params.startTime.getTime(),
    costUsd: estimateCostUsd(params.model, params.usage),
    fallbackUsed: params.fallbackUsed,
    schemaValid: params.schemaValid,
    tenantId: params.tenantId ?? null,
    // search_id queda null: estas llamadas corren ANTES del insert en active_searches (ver
    // searchSegmentProcessor.ts), así que el id todavía no existe en el momento de persistir.
    searchId: null
  });
}

export function logFallbackWarning(providerName: string, error: unknown): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  // Los SDKs de Gemini/OpenAI no comparten una clase de error tipada con `.status`/`.statusCode`
  // — se narrowea con un chequeo de forma estructural en vez de `any`.
  const statusCode = typeof error === 'object' && error !== null && ('status' in error || 'statusCode' in error)
    ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { status?: unknown; statusCode?: unknown }).statusCode
    : undefined;
  const isQuotaError = errMsg.includes('429') ||
    errMsg.toLowerCase().includes('quota') ||
    errMsg.includes('RESOURCE_EXHAUSTED') ||
    statusCode === 429;

  if (isQuotaError) {
    logger.warn({ providerName }, '[AI] Límite de cuota excedido (429/Resource Exhausted). Cambiando de proveedor (ejecutando fallback)...');
  } else {
    logger.warn({ providerName, err: errMsg }, '[AI] Falló el proveedor debido a un error inesperado. Cambiando de proveedor (ejecutando fallback)...');
  }
}
