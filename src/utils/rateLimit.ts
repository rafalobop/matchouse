// KAN-71: generalización del rate limiter en memoria que ya existía inline en src/index.ts
// para /api/auth/request-magic-link (5 req/min por IP). Se extrae a un módulo compartido,
// parametrizable, para poder aplicarlo también a POST /api/search y POST /api/upload sin
// duplicar la lógica de ventana/contador — mismo patrón de extracción que withTimeout (KAN-70).

import { SupabaseClient } from '@supabase/supabase-js';
import { supabase as serviceRoleSupabase } from '../services/supabase';
import { logger } from '../services/logger';

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

export interface DistributedRateLimiter {
  /**
   * Igual que `RateLimiter.check`, pero async: el estado vive en Postgres (round-trip de red),
   * no en memoria del proceso.
   */
  check(key: string): Promise<boolean>;
}

/**
 * KAN-127: variante distribuida de `createRateLimiter` — mismo concepto (ventana fija, contador
 * por key), pero el estado vive en la tabla `rate_limit_counters` de Postgres (vía la función
 * `rate_limit_check`, migración `create_rate_limit_counters_table`) en vez de un `Map` local.
 * Todas las instancias del proceso Node ven el mismo contador para la misma key — soluciona el
 * problema que documenta `createRateLimiter` de arriba (el límite efectivo se multiplica por N
 * instancias detrás de un balanceador de carga). Ver docs/rate-limit-backends.md para por qué se
 * eligió Postgres en vez de Redis/Upstash.
 *
 * `limiterId` prefija la key (ej. `"search"`, `"upload"`, `"auth"`) para que un mismo
 * tenantId/IP no comparta contador entre limiters distintos que conviven en la misma tabla.
 *
 * Fail-open ante un error de Postgres (log + `true`): un rate limiter que no puede consultarse no
 * debe tumbar el endpoint que protege — además, si Postgres no responde, la mayoría de las
 * operaciones protegidas (que también dependen de Postgres) van a fallar igual más abajo en el
 * propio handler, así que bloquear acá no evita nada, solo agrega un punto de falla extra.
 */
export function createDistributedRateLimiter(
  limiterId: string,
  maxRequests: number,
  windowMs: number,
  client: SupabaseClient = serviceRoleSupabase
): DistributedRateLimiter {
  return {
    async check(key: string): Promise<boolean> {
      const fullKey = `${limiterId}:${key}`;
      const { data, error } = await client.rpc('rate_limit_check', {
        p_key: fullKey,
        p_max_requests: maxRequests,
        p_window_ms: windowMs
      });

      if (error) {
        logger.error(
          { err: error.message, key: fullKey },
          '[RATE-LIMIT] Error consultando rate_limit_check — fail-open (se permite el request)'
        );
        return true;
      }

      return data === true;
    }
  };
}
