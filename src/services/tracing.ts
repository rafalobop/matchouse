// BE-03: tracing de POST /api/search (segmentación → extracción → zona → matching →
// notificación) con Langfuse. Encapsula el SDK acá para que el resto del código nunca importe
// @langfuse/tracing/@langfuse/otel directamente — si el día de mañana se cambia de backend de
// tracing, solo se toca este archivo.
//
// Sin LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY (ver config/env.ts), initTracing() no registra
// ningún TracerProvider: @opentelemetry/api cae a su NoopTracerProvider global por defecto, así
// que startObservation/startActiveObservation siguen siendo llamables y seguras — simplemente no
// exportan nada. La app arranca y las búsquedas funcionan igual.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { startActiveObservation, startObservation, propagateAttributes, type LangfuseObservationType } from '@langfuse/tracing';
import { config } from '../config/env';
import { estimateCostUsd } from '../config/modelPricing';
import { logger } from './logger';

// Setup oficial de Langfuse para JS/TS SDK v6 (ver
// https://langfuse.com/docs/observability/sdk/overview#setup) — NodeSDK + LangfuseSpanProcessor
// sin exporter custom. Verificado en vivo contra el proyecto real de Langfuse de este repo: una
// traza de prueba (span raíz + generation anidada) apareció correctamente vía la API pública
// (GET /api/public/v2/observations) con el parentObservationId esperado.
let sdk: NodeSDK | null = null;

export function initTracing(): void {
  if (!config.langfusePublicKey || !config.langfuseSecretKey) {
    logger.warn('[TRACING] Langfuse no configurado (faltan LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY); tracing deshabilitado (no-op).');
    return;
  }

  // exportMode: 'immediate' en vez del default 'batched' porque hoy no hay drenaje de buffers más
  // allá del shutdown ordenado de src/index.ts (ver shutdownTracing) — evita perder spans ante un
  // crash/restart que no pase por SIGTERM.
  sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor({
      publicKey: config.langfusePublicKey,
      secretKey: config.langfuseSecretKey,
      baseUrl: config.langfuseBaseUrl,
      // BE-03 (best practice de Langfuse): separa trazas de dev/test de las de producción para
      // que no se mezclen en el mismo dashboard/evaluaciones.
      environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      exportMode: 'immediate'
    })]
  });
  sdk.start();

  logger.info('[TRACING] Langfuse tracing habilitado.');
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
}

type SpanAttrs = Record<string, unknown>;

// OTel devuelve este sentinel de 32 ceros (no `undefined`) como traceId de un span no-op cuando
// no hay ningún TracerProvider registrado (ver initTracing) — es el INVALID_TRACEID de la spec de
// OpenTelemetry, estable entre versiones. Sin este chequeo, se persistiría ese valor "válido pero
// sin sentido" en active_searches.trace_id en vez de null.
const OTEL_INVALID_TRACE_ID = '0'.repeat(32);

// Envuelve TODO un request de POST /api/search en una traza raíz, con tenantId propagado como
// userId de Langfuse (https://langfuse.com/docs/observability/features/users) a TODAS las
// observaciones hijas (generations de ai.ts, spans de withSpan) sin tener que pasarlo a mano en
// cada una — habilita las vistas de "por usuario" (costo/latencia por tenant) en Langfuse.
// `input` es el texto real de la búsqueda (no un resumen) — es lo más útil para un humano que
// revisa la traza, siguiendo "Choose meaningful input and output" de
// https://langfuse.com/docs/observability/best-practices. `fn` recibe el trace_id (32 hex chars,
// o undefined si no hay tracer registrado) para que el caller lo persista en active_searches, y
// su valor de retorno se usa como output de la traza raíz.
export async function traceSearchRequest<T>(
  name: string,
  attrs: { userId: string; input: unknown },
  fn: (traceId: string | undefined) => Promise<T>
): Promise<T> {
  return startActiveObservation(name, async (span) => {
    span.update({ input: attrs.input });
    const traceId = span.traceId === OTEL_INVALID_TRACE_ID ? undefined : span.traceId;
    const result = await propagateAttributes({ userId: attrs.userId }, () => fn(traceId));
    span.update({ output: result as unknown });
    return result;
  }, {});
}

// Span/observation genérico (no-LLM) para un paso del pipeline (un segmento, matching,
// notificación). `asType` por default 'span'; pasar 'retriever' para lookups de solo lectura
// (ej. matching cross-tenant) o 'tool' para una acción con efecto externo (ej. notificar) — ver
// https://langfuse.com/docs/observability/features/observation-types. Anida automáticamente bajo
// el span activo del contexto OTel ambient (AsyncLocalStorage) — ni siquiera dentro de un
// Promise.all de segmentos en paralelo hace falta pasar el padre a mano, porque cada rama async
// que llama a withSpan abre su propio boundary aislado.
export async function withSpan<T>(
  name: string,
  attrs: SpanAttrs,
  fn: () => Promise<T>,
  options: { asType?: LangfuseObservationType } = {}
): Promise<T> {
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
  }, { asType: options.asType } as Parameters<typeof startActiveObservation>[2]);
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
