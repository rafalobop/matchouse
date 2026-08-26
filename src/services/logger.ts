import pino from 'pino';
import * as Sentry from '@sentry/node';
import { buildLogRedactionConfig } from '../config/logRedaction';
import { decideSentryForwarding, extractLogPayloadForSentry } from '../utils/sentryForwarding';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined, // Remueve pid y hostname para mayor claridad
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: buildLogRedactionConfig(), // KAN-135: redacta PII (email, ip, domicilio, etc.) en logs de texto plano
  hooks: {
    // KAN-83: único punto de reenvío a Sentry de toda la app — cualquier `logger.error`/`.fatal`
    // existente se vuelve una alerta "crítica" (Sentry level error/fatal, alerta inmediata) y
    // cualquier `logger.warn` se vuelve "leve" (Sentry level warning, resumen periódico), sin
    // tocar los ~100+ call sites ya existentes. Ver src/utils/sentryForwarding.ts para la lógica
    // pura de clasificación/extracción (testeada sin SDK real) y docs/RUNBOOK.md para los
    // criterios de alerta y la config de Alert Rules que hay que crear en el dashboard de Sentry.
    logMethod(inputArgs, method, level) {
      const decision = decideSentryForwarding(level);
      if (decision) {
        const { error, message, context } = extractLogPayloadForSentry(inputArgs);
        Sentry.withScope((scope) => {
          scope.setTag('severity', decision.severity);
          scope.setLevel(decision.sentryLevel);
          scope.setContext('log', context);
          if (error) {
            Sentry.captureException(error);
          } else {
            Sentry.captureMessage(message || '(sin mensaje)', decision.sentryLevel);
          }
        });
      }
      return method.apply(this, inputArgs);
    }
  }
});
