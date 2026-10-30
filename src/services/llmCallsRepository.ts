// BE-04: persiste una fila en llm_calls por cada llamada LLM real del pipeline (extracción,
// zona, segmentación, mapeo de Excel) — ver ai.ts, únicos llamadores. Vive separado de
// tracing.ts (que solo habla con Langfuse) porque esto es una tabla propia del proyecto: permite
// consultar costo/latencia por tenant sin depender de la API de Langfuse en runtime.
//
// El cliente se recibe inyectado (no se importa el singleton `supabase` acá) para que los tests
// puedan pasar un fake sin red real — ver tests/llmCallsRepository.test.ts.
import type { TypedSupabaseClient } from './supabase';
import { logger } from './logger';

export interface LlmCallRecord {
  operation: string;
  model: string;
  promptVersion?: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
  fallbackUsed: boolean;
  schemaValid: boolean;
  tenantId?: string | null;
  searchId?: string | null;
}

// Puramente observabilidad, sin valor de negocio — nunca debe poder romper el flujo real de
// extracción (mismo criterio que recordLlmGeneration en tracing.ts): cualquier error se loguea y
// se descarta, no se re-lanza. No se awaitea desde los llamadores (ver ai.ts).
export async function recordLlmCall(client: TypedSupabaseClient, record: LlmCallRecord): Promise<void> {
  try {
    const { error } = await client.from('llm_calls').insert({
      operation: record.operation,
      model: record.model,
      prompt_version: record.promptVersion ?? null,
      tokens_in: record.tokensIn,
      tokens_out: record.tokensOut,
      latency_ms: record.latencyMs,
      cost_usd: record.costUsd,
      fallback_used: record.fallbackUsed,
      schema_valid: record.schemaValid,
      tenant_id: record.tenantId ?? null,
      search_id: record.searchId ?? null
    });
    if (error) throw error;
  } catch (error: any) {
    logger.warn({ error: error.message || error, operation: record.operation }, '[LLM CALLS] No se pudo persistir la fila de métricas (no afecta la extracción ya resuelta).');
  }
}

// Costo total en USD de un tenant dentro de un mes calendario (año/mes en UTC). `month` es 1-12.
// Usada por BE-45 (endpoint de métricas del panel admin) — acá solo se deja la query probada y
// funcionando, ver criterio de aceptación "consulta de costo por tenant/mes funciona".
export async function getLlmCostByTenantForMonth(
  client: TypedSupabaseClient,
  tenantId: string,
  year: number,
  month: number
): Promise<number> {
  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const end = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)).toISOString();

  const { data, error } = await client
    .from('llm_calls')
    .select('cost_usd')
    .eq('tenant_id', tenantId)
    .gte('created_at', start)
    .lt('created_at', end);

  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd), 0);
}
