// KAN-126: metadata real de cookies/headers sensibles de la app — extraída por inspección directa
// del código (no una lista inventada a mano), única fuente de verdad para la config de Sentry
// (`dataCollection`, ver instrument.js). Si mañana se agrega una cookie/header de credencial
// nueva, hay que sumarla acá — el plan de auditoría periódica de docs/sentry-security-audit.md
// existe justamente para detectar ese drift antes de que un token termine filtrado a Sentry.

/** Cookies de sesión/acceso — ver src/index.ts y src/adminAuth.ts#ADMIN_SESSION_COOKIE. */
export const SENSITIVE_COOKIE_NAMES = [
  'brokaza_session', // sesión de tenant: access_token de Supabase en texto plano
  'brokaza_admin_session', // sesión de admin: idem, panel admin
  'brokaza_access' // access gate pre-lanzamiento: token HMAC del código de acceso privado
];

/**
 * Headers que transportan una credencial — ver src/services/supabase.ts#getTenantClient
 * (`Authorization: Bearer <token>`) y src/index.ts (`x-internal-secret`, header del webhook
 * interno de Postgres). `cookie` se deniega también acá porque el header crudo `Cookie` incluye
 * los 3 valores de `SENSITIVE_COOKIE_NAMES` tal cual, sin pasar por el filtro de `cookies` de
 * abajo (ese filtro solo controla el jar de cookies ya parseado que arma el propio Sentry).
 */
export const SENSITIVE_HEADER_NAMES = ['authorization', 'cookie', 'x-internal-secret'];

export interface SentryDataCollectionOptions {
  httpBodies: never[];
  cookies: { deny: string[] };
  httpHeaders: {
    request: { deny: string[] };
    response: { deny: string[] };
  };
}

/**
 * Config de `dataCollection` para `Sentry.init()` (KAN-126, SDK v10+).
 *
 * - `httpBodies: []`: desactiva por completo la captura de bodies HTTP. La app maneja emails,
 *   teléfonos y `access_token` en bodies de `/api/auth/*` y `/api/profile` — mantener una lista de
 *   rutas excluidas en vez de esto sería más frágil (hay que acordarse de actualizarla cada vez
 *   que se agrega un endpoint nuevo con datos sensibles) sin ganar nada a cambio, ya que ningún
 *   endpoint de esta app depende de que Sentry vea el body para debuggear.
 * - `cookies`/`httpHeaders` usan denylist explícita (no `false`/deshabilitar todo), para no perder
 *   otras cookies/headers inocuos que sí sirven para debuggear un error real.
 */
export function buildSentryDataCollectionConfig(): SentryDataCollectionOptions {
  return {
    httpBodies: [],
    cookies: { deny: [...SENSITIVE_COOKIE_NAMES] },
    httpHeaders: {
      request: { deny: [...SENSITIVE_HEADER_NAMES] },
      response: { deny: [...SENSITIVE_HEADER_NAMES] }
    }
  };
}
