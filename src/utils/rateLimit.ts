// KAN-71: generalización del rate limiter en memoria que ya existía inline en src/index.ts
// para /api/auth/request-magic-link (5 req/min por IP). Se extrae a un módulo compartido,
// parametrizable, para poder aplicarlo también a POST /api/search y POST /api/upload sin
// duplicar la lógica de ventana/contador — mismo patrón de extracción que withTimeout (KAN-70).

export interface RateLimiter {
  /**
   * Registra un intento para `key` y devuelve `true` si está permitido, `false` si superó el
   * límite configurado dentro de la ventana actual.
   */
  check(key: string): boolean;
}

/**
 * Rate limiter en memoria de ventana fija, por clave arbitraria (IP, tenantId, etc.).
 * No es distribuido: cada instancia del proceso Node lleva su propio conteo en memoria. Es el
 * mismo trade-off que ya aceptaba el rate limiter original de /api/auth/request-magic-link —
 * válido mientras la app corra como un único proceso (no hay Redis ni balanceador de carga
 * multi-instancia en la infraestructura real de este proyecto, ver .agent/CONTEXT.md).
 */
export function createRateLimiter(maxRequests: number, windowMs: number): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now > entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (entry.count >= maxRequests) return false;
      entry.count++;
      return true;
    }
  };
}
