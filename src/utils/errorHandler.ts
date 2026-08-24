import express from 'express';
import { logger } from '../services/logger';

// KAN-124: manejador de errores global — sin esto, cualquier excepción no capturada dentro de una
// ruta (incluida una promesa rechazada dentro de un handler async, que Express 5 reenvía acá
// automáticamente) caía en el manejador de errores por defecto de Express, que puede incluir el
// stack trace en la respuesta HTTP si NODE_ENV no es 'production' (ver nodeEnvCheck.ts). Se monta
// en src/index.ts DESPUÉS de mountAdminRouter y de todas las rutas de tenant/API, así que también
// atrapa errores que suben desde adminRouter (KAN-124 AC4) — adminRouter no define su propio
// manejador de errores, solo un catch-all de 404 sin firma de error (4 argumentos), así que
// cualquier next(err) (o excepción async no atrapada) dentro del panel admin sigue subiendo hasta
// este handler, igual que las rutas de tenant.

/**
 * Manejador de errores global de Express (4 argumentos = firma de error-handling middleware).
 * Loguea el error completo con `logger.error` y responde siempre con el mismo JSON genérico,
 * sin exponer el mensaje/stack real del error al cliente.
 */
export function globalErrorHandler(
  err: Error,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  logger.error(
    { err: err.message, stack: err.stack, path: req.path, method: req.method },
    '[ERROR] Excepción no controlada en una ruta'
  );

  // Convención de Express: si la respuesta ya empezó a enviarse (ej. streaming a medio camino),
  // no se puede mandar un JSON nuevo encima — delegar al manejador de errores por defecto, que
  // sabe cerrar la conexión de forma segura en ese caso.
  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: 'Error interno' });
}
