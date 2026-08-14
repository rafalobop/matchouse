import express from 'express';
import { logger } from '../services/logger';

// KAN-124: sin este chequeo, un despliegue real donde NODE_ENV no llegó a setearse a 'production'
// (por variable de entorno mal copiada/faltante en el hosting) queda con el manejador de errores
// por defecto de Express en modo "development" — que incluye el stack trace de la excepción en la
// respuesta HTTP ante cualquier error no controlado. No aborta el arranque (a diferencia de las
// credenciales de Supabase, KAN-122): en desarrollo local es normal y esperado no tener
// NODE_ENV=production seteada, así que esto solo advierte, nunca bloquea.

let nodeEnvWarningLogged = false;

/**
 * Middleware de Express: verifica `NODE_ENV` y deja un `logger.warn` si no es `'production'`.
 * La advertencia se loguea una sola vez por proceso (no en cada request) — spamear el mismo
 * warning en cada request no aporta nada nuevo y ensucia los logs bajo tráfico real.
 */
export function nodeEnvCheckMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!nodeEnvWarningLogged) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn(
        { nodeEnv: process.env.NODE_ENV ?? '(sin definir)' },
        '[CONFIG] NODE_ENV no está seteada a "production". Si este es un entorno de producción real, ' +
        'el manejador de errores por defecto de Express puede incluir stack traces en las respuestas HTTP.'
      );
    }
    nodeEnvWarningLogged = true;
  }
  next();
}

/** Solo para tests: permite que el warning se vuelva a evaluar en el siguiente request. */
export function __resetNodeEnvWarningForTests(): void {
  nodeEnvWarningLogged = false;
}
