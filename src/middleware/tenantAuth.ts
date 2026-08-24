import * as express from 'express';
import { supabase, getTenantClient } from '../services/supabase';
import { logger } from '../services/logger';
import { withTimeout } from '../utils/withTimeout';

// Cache en memoria de sesiones ya validadas contra Supabase. El dashboard pollea /api/status,
// /api/matches y /api/catalog cada 1.5-5s; sin este cache, cada poll disparaba una llamada de red
// a la API de Auth de Supabase, lo que en un entorno con red inestable causaba 401 intermitentes
// y deslogueos falsos (ver interceptor de fetch en app.js).
const SESSION_CACHE_TTL_MS = 30_000;
const sessionCache = new Map<string, { tenantId: string; expiresAt: number }>();

function getCachedSession(token: string) {
  const entry = sessionCache.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessionCache.delete(token);
    return null;
  }
  return entry;
}

export function clearCachedSession(token: string) {
  sessionCache.delete(token);
}

export async function tenantAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.cookies?.brokaza_session;
  if (!token) {
    return res.status(401).json({ error: 'No autenticado.' });
  }

  // KAN-63 (patrón "Tenant Context"): req.supabaseClient queda scoped al tenant (anon key +
  // el propio access_token del usuario como Bearer), NO al cliente service-role. Esto hace que
  // PostgREST aplique RLS de verdad en cada request autenticado del dashboard, en vez de que RLS
  // sea solo defensa en profundidad nunca ejercitada por el tráfico real de la app.
  const cached = getCachedSession(token);
  if (cached) {
    (req as any).tenantId = cached.tenantId;
    (req as any).supabaseClient = getTenantClient(token);
    return next();
  }

  try {
    const { data: { user }, error }: any = await withTimeout(
      supabase.auth.getUser(token), 10_000, 'Supabase getUser (tenantAuthMiddleware)'
    );
    if (error?.name === 'AuthRetryableFetchError') {
      // Fallo transitorio de red/TLS hacia Supabase: no invalidamos la sesión del tenant por esto,
      // sólo devolvemos 503 para que el cliente reintente en el próximo poll.
      logger.error({ supabaseError: error.message, cause: error.cause }, '[AUTH] No se pudo conectar con Supabase al validar sesión de tenant');
      return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación.' });
    }
    if (error || !user) {
      logger.warn({ supabaseError: error?.message }, '[AUTH] Sesión inválida o expirada en tenantAuthMiddleware');
      clearCachedSession(token);
      res.clearCookie('brokaza_session');
      return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }
    sessionCache.set(token, { tenantId: user.id, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
    (req as any).tenantId = user.id;
    (req as any).supabaseClient = getTenantClient(token);
    next();
  } catch (err: any) {
    logger.error({ err: err.message }, '[AUTH] Error inesperado en tenantAuthMiddleware (posible timeout de red hacia Supabase)');
    return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación.' });
  }
}
