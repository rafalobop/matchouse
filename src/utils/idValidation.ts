// KAN-40: validacion de UUIDs recibidos como parametro de ruta (ej. DELETE /api/searches/:id).
// Modulo puro separado de src/index.ts por el mismo motivo que searchValidation.ts (ese archivo
// arranca el servidor completo al importarse, no se puede importar desde tests).

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(value: unknown): boolean {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
