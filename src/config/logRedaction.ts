// KAN-135: metadata real de los campos de PII que hoy viajan en llamadas a `logger.*` — extraída
// por inspección directa de src/ (no una lista inventada a mano), única fuente de verdad para la
// config `redact` de Pino (ver src/services/logger.ts). Si mañana se agrega un campo de PII nuevo
// a un log estructurado, hay que sumar su key acá.

/**
 * Nombres de key (siempre en la raíz del objeto que se le pasa a `logger.*`, nunca anidados) que
 * hoy transportan PII en algún punto de la app:
 * - `email`/`adminEmail`: emails de tenant/admin (auth, perfil, panel admin).
 * - `ip`: IP del request en el flujo de magic link (rate limiting).
 * - `address`: domicilio de una propiedad (blindMatching.ts, excel.ts).
 * - `query`/`raw`: texto de dirección consultado al servicio de geocoding y su resultado crudo
 *   (geocoding.ts) — ambos contienen el domicilio en texto libre.
 * - `texto`: texto de ubicación tal cual lo escribió el usuario (ai.ts, resolución de zona).
 * - `segmentText`: segmento de búsqueda en texto libre del usuario (index.ts).
 */
export const PII_LOG_FIELDS = ['email', 'adminEmail', 'ip', 'address', 'query', 'raw', 'texto', 'segmentText'];

export const PII_REDACT_CENSOR = '[REDACTED]';

export interface LogRedactionConfig {
  paths: string[];
  censor: string;
}

/**
 * Config `redact` para `pino()` (KAN-135). Devuelve la censura por valor (no `remove: true`) para
 * no romper la interoperabilidad con terceros que consumen estos logs y esperan la key presente
 * (parsers/dashboards que la buscan por nombre) — solo cambia el valor sensible, no la forma del log.
 */
export function buildLogRedactionConfig(): LogRedactionConfig {
  return {
    paths: [...PII_LOG_FIELDS],
    censor: PII_REDACT_CENSOR
  };
}
