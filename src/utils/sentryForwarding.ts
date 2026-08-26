import { PII_LOG_FIELDS } from '../config/logRedaction';

// KAN-83: hasta este ticket, `Sentry.init()` corría (instrument.js) pero ningún punto del código
// llamaba `Sentry.captureException`/`captureMessage` — todos los errores se logueaban con Pino y
// nunca llegaban a Sentry, así que no existía ninguna alerta real posible más allá de una
// excepción verdaderamente no controlada que tirara el proceso. Este módulo es la lógica pura
// (sin tocar el SDK de Sentry, testeable sin red) que decide QUÉ reenviar y CÓMO clasificarlo,
// consumida por el hook `hooks.logMethod` de `services/logger.ts` — cualquier `logger.error`
// (o `.fatal`) existente en el código pasa a ser "crítico" (alerta inmediata) y cualquier
// `logger.warn` pasa a ser "leve" (resumen periódico), sin tener que tocar los ~100+ call sites
// ya existentes de `logger.error`/`logger.warn` en todo el repo.

export type SentrySeverity = 'critical' | 'low';
export type SentryLevel = 'fatal' | 'error' | 'warning';

export interface SentryForwardDecision {
  severity: SentrySeverity;
  sentryLevel: SentryLevel;
}

// Niveles numéricos estándar de Pino: trace=10, debug=20, info=30, warn=40, error=50, fatal=60.
// `info`/`debug`/`trace` nunca se reenvían — son operación normal, no señal de error.
export function decideSentryForwarding(pinoLevel: number): SentryForwardDecision | null {
  if (pinoLevel >= 60) return { severity: 'critical', sentryLevel: 'fatal' };
  if (pinoLevel >= 50) return { severity: 'critical', sentryLevel: 'error' };
  if (pinoLevel === 40) return { severity: 'low', sentryLevel: 'warning' };
  return null;
}

export interface ExtractedLogPayload {
  error?: Error;
  message?: string;
  context: Record<string, unknown>;
}

/**
 * Extrae de los argumentos crudos de una llamada `logger.error(...)`/`logger.warn(...)` (que en
 * este repo siempre son `(objetoDeContexto, mensaje)` o solo `mensaje`) el `Error` real si lo hay,
 * el mensaje, y el resto del contexto — filtrando explícitamente cualquier campo de
 * `PII_LOG_FIELDS` (KAN-135, misma lista que ya usa la redacción de Pino) antes de que el llamador
 * lo adjunte a Sentry como contexto extra. Necesario porque el hook de Pino corre ANTES de la
 * redacción de `pino({ redact })` — sin este filtro, el reenvío a Sentry se saltearía por completo
 * la protección de PII que ya existe para los logs de texto plano.
 */
export function extractLogPayloadForSentry(inputArgs: unknown[]): ExtractedLogPayload {
  const context: Record<string, unknown> = {};
  let error: Error | undefined;
  let message: string | undefined;

  for (const arg of inputArgs) {
    if (arg instanceof Error) {
      error = error ?? arg;
      continue;
    }
    if (typeof arg === 'string') {
      message = arg;
      continue;
    }
    if (arg && typeof arg === 'object') {
      for (const [key, value] of Object.entries(arg as Record<string, unknown>)) {
        if (value instanceof Error) {
          error = error ?? value;
          continue;
        }
        if (PII_LOG_FIELDS.includes(key)) continue;
        context[key] = value;
      }
    }
  }

  return { error, message, context };
}
