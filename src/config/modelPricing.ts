// BE-04: tabla de precios por modelo, extraída de tracing.ts (BE-03) para que el mismo cálculo de
// costo se use tanto en los spans de Langfuse (ver services/tracing.ts) como en las filas
// persistidas de llm_calls (ver services/llmCallsRepository.ts) sin duplicar los números.
//
// Precios aproximados a mano (USD por 1.000 tokens) — a verificar contra las páginas de precios
// reales de cada proveedor cuando se necesite exactitud (ver BE-46, comparativa de modelos). Mismo
// criterio de "no fabricar precisión" que en BE-02: un modelo no listado acá cuesta 0 en vez de
// inventar un número.
const MODEL_PRICING_USD_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite': { input: 0.0001, output: 0.0004 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 }
};

export function estimateCostUsd(model: string, usage?: { inputTokens: number; outputTokens: number }): number {
  if (!usage) return 0;
  const pricing = MODEL_PRICING_USD_PER_1K_TOKENS[model];
  if (!pricing) return 0;
  return (usage.inputTokens / 1000) * pricing.input + (usage.outputTokens / 1000) * pricing.output;
}
