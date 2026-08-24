// KAN-40: validacion de UUIDs recibidos como parametro de ruta (ej. DELETE /api/searches/:id).
// Modulo puro separado de src/index.ts por el mismo motivo que searchValidation.ts (ese archivo
// arranca el servidor completo al importarse, no se puede importar desde tests).

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// KAN-139: type predicate (antes devolvía `boolean` liso) — sin cambio de comportamiento en
// runtime, pero ahora TypeScript angosta `id`/`property_id` a `string` después de un
// `if (!isValidUUID(x)) return ...`. Esto destapó un problema real de tipado laxo: `req.params.id`
// (Express) infiere `string | string[]`, y antes de tipar `supabase.ts` con `Database` (KAN-139)
// el cliente de Supabase aceptaba cualquier cosa en `.eq()` sin chequeo — ahora que sí valida
// contra el schema real, sin este predicate cada `.eq('id', id)` posterior al guard rompía la
// compilación aunque el guard ya garantizaba en runtime que era un string.
export function isValidUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
