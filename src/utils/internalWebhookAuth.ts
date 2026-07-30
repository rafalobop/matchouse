// KAN-79: valida el secreto compartido de POST /internal/property-match-check — endpoint sin
// sesión de usuario (lo llama el trigger de Postgres vía pg_net, no un tenant autenticado), así
// que necesita su propio mecanismo de auth. Módulo puro separado de src/index.ts por el mismo
// motivo que idValidation.ts (ese archivo arranca el servidor completo al importarse).

import { timingSafeEqual } from 'crypto';

export function isValidInternalWebhookSecret(headerValue: unknown, expectedSecret: string): boolean {
  if (typeof headerValue !== 'string' || !expectedSecret) return false;

  const provided = Buffer.from(headerValue);
  const expected = Buffer.from(expectedSecret);

  // timingSafeEqual exige buffers del mismo largo — comparar el largo primero no filtra nada
  // útil a un atacante (ya conoce el formato del secreto), pero evita que timingSafeEqual tire.
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}
