// BE-03: tracing de POST /api/search (segmentación → extracción → zona → matching →
// notificación) con Langfuse. Encapsula el SDK acá para que el resto del código nunca importe
// @langfuse/tracing/@langfuse/otel directamente — si el día de mañana se cambia de backend de
// tracing, solo se toca este archivo.
//
// Sin LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY (ver config/env.ts), initTracing() no registra
// ningún TracerProvider: @opentelemetry/api cae a su NoopTracerProvider global por defecto, así
// que startObservation/startActiveObservation siguen siendo llamables y seguras — simplemente no
// exportan nada. La app arranca y las búsquedas funcionan igual.
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startActiveObservation, startObservation } from '@langfuse/tracing';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { config } from '../config/env';
import { logger } from './logger';

let provider: NodeTracerProvider | null = null;

export function initTracing(): void {
  if (!config.langfusePublicKey || !config.langfuseSecretKey) {
    logger.warn('[TRACING] Langfuse no configurado (faltan LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY); tracing deshabilitado (no-op).');
    return;
  }

  // @langfuse/otel@6.0.2 declara @opentelemetry/core como peerDependency ^2.0.1, pero el exporter
  // OTLP que arma por default (cuando no se le pasa `exporter`) depende de
  // @opentelemetry/otlp-exporter-base@0.300.0, que a su vez trae @opentelemetry/core@3.0.0 — un
  // conflicto real del paquete publicado. Se evita pasando un exporter propio, apuntado al mismo
  // endpoint/headers que documenta el SDK de Langfuse, construido con la generación 2.x de OTel
  // que el resto del proyecto ya usa (ver @sentry/opentelemetry, que también resuelve a 2.12.0).
  const authHeader = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const exporter = new OTLPTraceExporter({
    url: `${config.langfuseBaseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${authHeader}`,
      'x-langfuse-public-key': config.langfusePublicKey
    }
  });

  // exportMode: 'immediate' en vez del default 'batched' porque hoy no hay drenaje de buffers más
  // allá del shutdown ordenado de src/index.ts (ver shutdownTracing) — evita perder spans ante un
  // crash/restart que no pase por SIGTERM.
  provider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor({ exporter, exportMode: 'immediate' })]
  });
  provider.register();
  setLangfuseTracerProvider(provider);

  logger.info('[TRACING] Langfuse tracing habilitado.');
}

export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  await provider.shutdown();
}

type SpanAttrs = Record<string, unknown>;

// OTel devuelve este sentinel de 32 ceros (no `undefined`) como traceId de un span no-op cuando
// no hay ningún TracerProvider registrado (ver initTracing) — es el INVALID_TRACEID de la spec de
// OpenTelemetry, estable entre versiones. Sin este chequeo, se persistiría ese valor "válido pero
// sin sentido" en active_searches.trace_id en vez de null.
const OTEL_INVALID_TRACE_ID = '0'.repeat(32);

// Envuelve TODO un request de POST /api/search en una traza raíz. `fn` recibe el trace_id (string
// de 32 hex chars, o undefined si no hay tracer registrado) para que el caller lo persista en
// active_searches.
export async function traceSearchRequest<T>(name: string, attrs: SpanAttrs, fn: (traceId: string | undefined) => Promise<T>): Promise<T> {
  return startActiveObservation(name, async (span) => {
    span.update({ input: attrs });
    const traceId = span.traceId === OTEL_INVALID_TRACE_ID ? undefined : span.traceId;
    return fn(traceId);
  }, {});
}

// Span genérico (no-LLM) para un paso del pipeline (un segmento, matching, notificación). Anida
// automáticamente bajo el span activo del contexto OTel ambient (AsyncLocalStorage) — ni siquiera
// dentro de un Promise.all de segmentos en paralelo hace falta pasar el padre a mano, porque cada
// rama async que llama a withSpan abre su propio boundary aislado.
export async function withSpan<T>(name: string, attrs: SpanAttrs, fn: () => Promise<T>): Promise<T> {
  return startActiveObservation(name, async (span) => {
    span.update({ input: attrs });
    try {
      const result = await fn();
      span.update({ output: result as unknown });
      return result;
    } catch (error) {
      span.update({ level: 'ERROR', statusMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, {});
}

// BE-03: precios aproximados a mano (USD por 1.000 tokens) — a verificar contra las páginas de
// precios reales de cada proveedor cuando se necesite exactitud (ver BE-46, comparativa de
// modelos). Mismo criterio de "no fabricar precisión" que en BE-02: un modelo no listado acá
// cuesta 0 en vez de inventar un número.
const MODEL_PRICING_USD_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite': { input: 0.0001, output: 0.0004 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 }
};

function estimateCostUsd(model: string, usage?: { inputTokens: number; outputTokens: number }): number {
  if (!usage) return 0;
  const pricing = MODEL_PRICING_USD_PER_1K_TOKENS[model];
  if (!pricing) return 0;
  return (usage.inputTokens / 1000) * pricing.input + (usage.outputTokens / 1000) * pricing.output;
}

export interface LlmGenerationParams {
  name: string;
  model: string;
  promptVersion: string;
  input: unknown;
  output: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  fallbackUsed: boolean;
  schemaValid: boolean;
  startTime: Date;
  endTime?: Date;
  error?: string;
}

// Helper específico para los spans de tipo LLM — usado solo desde ai.ts. Se llama DESPUÉS de que
// la llamada real ya resolvió (o falló), así que no hace falta el patrón "crear antes / actualizar
// después": se crea y se cierra en el mismo call, con startTime/endTime explícitos para que la
// latencia mostrada en Langfuse sea la real de la llamada, no la del propio helper.
//
// Nunca debe poder romper el flujo real de extracción — es puramente observabilidad, sin valor de
// negocio — así que cualquier error acá se loguea y se descarta, no se re-lanza.
export function recordLlmGeneration(params: LlmGenerationParams): void {
  try {
    const endTime = params.endTime ?? new Date();
    const costUsd = estimateCostUsd(params.model, params.usage);
    const generation = startObservation(params.name, {
      input: params.input,
      output: params.output,
      model: params.model,
      usageDetails: params.usage ? { input: params.usage.inputTokens, output: params.usage.outputTokens } : undefined,
      costDetails: params.usage ? { total: costUsd } : undefined,
      level: params.error ? 'ERROR' : 'DEFAULT',
      statusMessage: params.error,
      metadata: {
        promptVersion: params.promptVersion,
        fallbackUsed: params.fallbackUsed,
        schemaValid: params.schemaValid
      }
    }, { asType: 'generation', startTime: params.startTime });
    generation.end(endTime);
  } catch (error) {
    logger.warn({ error, llmSpanName: params.name }, '[TRACING] No se pudo registrar el span de generación (no afecta la extracción ya resuelta).');
  }
}
