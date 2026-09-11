import express from 'express';
import { supabase } from './services/supabase';
import { logger } from './services/logger';
import { withTimeout } from './utils/withTimeout';

export const ADMIN_SESSION_COOKIE = 'brokaza_admin_session';

// Cache corto de sesiones admin ya validadas (mismo patrón que sessionCache en src/index.ts para
// tenants), para no pegarle a Supabase Auth + admin_users en cada poll del panel. TTL bajo a
// propósito: a diferencia del panel de tenants, acá una sesión revocada (ej. se borra el email de
// admin_users) debe dejar de funcionar rápido.
const ADMIN_SESSION_CACHE_TTL_MS = 15_000;
const adminSessionCache = new Map<string, { adminUserId: string; email: string; expiresAt: number }>();

export interface AdminIdentity {
  adminUserId: string;
  email: string;
}

function getCachedAdminSession(token: string): AdminIdentity | null {
  const entry = adminSessionCache.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    adminSessionCache.delete(token);
    return null;
  }
  return { adminUserId: entry.adminUserId, email: entry.email };
}

export function clearAdminSessionCache(token: string): void {
  adminSessionCache.delete(token);
}

/**
 * Confirma que un user_id de Supabase Auth está en la allowlist `admin_users` (RLS deny-all,
 * solo accesible con el client service-role). Ausencia = no autorizado, no es un error.
 */
export async function isAllowedAdminUser(userId: string): Promise<AdminIdentity | null> {
  const { data, error } = await supabase
    .from('admin_users')
    .select('user_id, email')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error({ err: error.message, userId }, '[ADMIN AUTH] Error consultando admin_users');
    return null;
  }
  if (!data) return null;
  return { adminUserId: data.user_id, email: data.email };
}

/**
 * Igual que isAllowedAdminUser, pero por email — usado en request-magic-link, antes de que exista
 * un user_id de sesión. Se usa siempre una respuesta genérica hacia el cliente independientemente
 * del resultado, para no filtrar por timing/mensaje qué emails están en la allowlist.
 */
export async function isAllowedAdminEmail(email: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('admin_users')
    .select('user_id')
    .ilike('email', email)
    .maybeSingle();

  if (error) {
    logger.error({ err: error.message, email }, '[ADMIN AUTH] Error consultando admin_users por email');
    return false;
  }
  return !!data;
}

/**
 * Middleware de autenticación del panel admin. Distinto del tenantAuthMiddleware de
 * src/index.ts en dos cosas clave: usa su propia cookie (ADMIN_SESSION_COOKIE, nunca
 * brokaza_session) y, además de validar el JWT contra Supabase Auth, re-chequea en cada request
 * (con cache corto) que ese user_id siga en la allowlist admin_users — quitar un email de la
 * tabla debe revocar el acceso en segundos, no solo en el próximo login.
 */
export async function adminAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.cookies?.[ADMIN_SESSION_COOKIE];
  if (!token) {
    return res.status(401).json({ error: 'No autenticado.' });
  }

  const cached = getCachedAdminSession(token);
  if (cached) {
    req.admin = cached;
    return next();
  }

  try {
    const { data: { user }, error }: any = await withTimeout(
      supabase.auth.getUser(token), 10_000, 'Supabase getUser (adminAuthMiddleware)'
    );
    if (error?.name === 'AuthRetryableFetchError') {
      logger.error({ supabaseError: error.message }, '[ADMIN AUTH] No se pudo conectar con Supabase al validar sesión admin');
      return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación.' });
    }
    if (error || !user) {
      clearAdminSessionCache(token);
      res.clearCookie(ADMIN_SESSION_COOKIE);
      return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    }

    const identity = await isAllowedAdminUser(user.id);
    if (!identity) {
      logger.warn({ userId: user.id }, '[ADMIN AUTH] Sesión válida en Supabase Auth pero user_id no está en admin_users');
      clearAdminSessionCache(token);
      res.clearCookie(ADMIN_SESSION_COOKIE);
      return res.status(403).json({ error: 'No autorizado.' });
    }

    adminSessionCache.set(token, { ...identity, expiresAt: Date.now() + ADMIN_SESSION_CACHE_TTL_MS });
    req.admin = identity;
    next();
  } catch (err: any) {
    logger.error({ err: err.message }, '[ADMIN AUTH] Error inesperado en adminAuthMiddleware');
    return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación.' });
  }
}
