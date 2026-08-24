import { Request, Response, NextFunction } from 'express';

// KAN-134: dos protecciones sobre el body JSON de rutas expuestas a input directo del usuario —
// (1) tamaño máximo explícito (antes quedaba en el default de 100kb de body-parser, nunca
// declarado a propósito en este repo) y (2) whitelist de campos: cualquier key no reconocida en
// el body se rechaza con 400 en vez de ser ignorada en silencio por el destructuring de cada
// ruta (defensa en profundidad contra mass-assignment, aunque hoy ningún controlador haga spread
// directo del body hacia un insert/update).

export const JSON_BODY_SIZE_LIMIT = '256kb';

// Módulo puro (sin acceso a red) por el mismo motivo que searchValidation.ts/profileValidation.ts
// — separado de src/index.ts, que arranca el servidor completo al importarse.
export function validateBodyWhitelist(body: unknown, allowedFields: readonly string[]): string | null {
  // Body ausente o no-objeto (undefined, null, array, primitivo): no es responsabilidad de este
  // chequeo — cada ruta ya valida por su cuenta la presencia/tipo de los campos requeridos.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const allowedSet = new Set(allowedFields);
  const unexpectedFields = Object.keys(body).filter(key => !allowedSet.has(key));

  if (unexpectedFields.length === 0) {
    return null;
  }

  return `El body contiene campos no permitidos: ${unexpectedFields.join(', ')}.`;
}

// Middleware de error de body-parser — se monta justo después de cada express.json() para
// traducir el error crudo que tira body-parser (al superar JSON_BODY_SIZE_LIMIT, o al recibir
// JSON malformado) en una respuesta clara, en vez de dejar que caiga en el 500 genérico del
// error handler global (mismo criterio que POST /api/upload ya aplica con los errores de multer,
// ver src/index.ts).
export function jsonBodyParseErrorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  if (err && err.type === 'entity.too.large') {
    res.status(413).json({ error: `El body de la request supera el tamaño máximo permitido (${JSON_BODY_SIZE_LIMIT}).` });
    return;
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    res.status(400).json({ error: 'El body de la request no es JSON válido.' });
    return;
  }
  next(err);
}
