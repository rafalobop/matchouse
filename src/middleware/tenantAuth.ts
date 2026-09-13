import * as express from 'express';
import { supabase, getTenantClient } from '../services/supabase';
import { logger } from '../services/logger';
import { withTimeout } from '../utils/withTimeout';

// Cache en memoria de sesiones ya validadas contra Supabase. El dashboard pollea /api/status,
// /api/matches y /api/catalog cada 1.5-5s; sin este cache, cada poll disparaba una llamada de red
// a la API de Auth de Supabase, lo que en un entorno con red inestable causaba 401 intermitentes
// y deslogueos falsos (ver interceptor de fetch en app.js).
const SESSION_CACHE_TTL_MS = 30_000;
const sessionCache = new Map<string, { actorId: string; tenantId: string; expiresAt: number }>();

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

// KAN-306 (continuación, 2026-09-04): resuelve el "scope efectivo de agencia" para `actorId` —
// si tiene `agency_owner_id` seteado (colaborador), devuelve el id del dueño; si no (dueño),
// devuelve su propio id. Usa el cliente service-role (no `req.supabaseClient`, que todavía no
// existe en este punto del flujo). Fail-safe ante error: cae a `actorId` (nunca bloquea el login
// ni expone datos de otra agencia por un error transitorio de red).
//
// Pase de UI 2026-09-04 (punto 6, colaboradores revocados/reactivables): `revokeCollaborator`
// (adminPanelController.ts) ya NO borra `agency_owner_id` al revocar — solo cambia
// `collaborator_status` a 'revoked', para poder reactivar después sin perder el vínculo. Esto es
// el enforcement REAL de esa revocación contra el tráfico de la app: los controllers de cartera
// usan `req.tenantId` con el cliente service-role (no RLS, ver nota de
// `add_agency_shared_tenant_scope_2026-09-04.sql`), así que si acá siguiéramos devolviendo
// `agency_owner_id` sin mirar `collaborator_status`, un colaborador "revocado" seguiría viendo
// la cartera compartida igual que uno activo. `current_agency_owner_id()` (RLS) tiene el mismo
// chequeo, como defensa en profundidad.
async function resolveEffectiveTenantId(actorId: string): Promise<string> {
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('agency_owner_id, collaborator_status')
      .eq('id', actorId)
      .maybeSingle();
    if (error) throw error;
    if (profile?.collaborator_status === 'revoked') return actorId;
    return profile?.agency_owner_id || actorId;
  } catch (err: any) {
    logger.error(
      { err: err.message, actorId },
      '[AUTH] Error al resolver el scope de agencia (agency_owner_id); se usa el id propio como fallback.'
    );
    return actorId;
  }
}

// KAN-76: solo para tests — siembra `sessionCache` directamente para poder ejercitar el router
// real con una cookie de sesión válida sin pegarle a la API de Auth real de Supabase (no hay
// credenciales reales disponibles en este sandbox, mismo límite documentado en tickets previos).
// Mismo patrón que `__expireTenantClientForTests`/`__setTenantClientForTests` en services/supabase.ts.
// `actorId` (KAN-306, continuación) es opcional y por defecto igual a `tenantId` — mantiene
// compatibilidad con todos los call sites existentes (dueño: actor === tenant); los tests de
// colaboradores lo pasan explícito y distinto.
export function __setCachedSessionForTests(token: string, tenantId: string, actorId: string = tenantId): void {
  sessionCache.set(token, { actorId, tenantId, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
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
  //
  // KAN-306 (continuación, 2026-09-04): `req.tenantId` YA NO es necesariamente `auth.uid()` —
  // es el "scope efectivo de agencia" (el id del dueño, ver resolveEffectiveTenantId): para un
  // colaborador, resuelve al id de su dueño; para un dueño, sigue siendo su propio id. Esto hace
  // que todos los controllers de cartera (properties/searches/matches/notifications/uploads/
  // planLimits/blindMatching), que ya usaban `req.tenantId` tal cual para leer y escribir, pasen
  // a operar automáticamente sobre los datos compartidos de la agencia sin cambios propios — la
  // RLS real (`current_agency_owner_id()`, ver migración `add_agency_shared_tenant_scope_
  // 2026-09-04.sql`) es quien lo autoriza contra Postgres. `req.actorId` es el auth.uid() real,
  // sin resolver — úsalo en vez de `tenantId` en cualquier lugar donde importe la identidad real
  // del que está logueado (perfil propio, panel de administración de agencia).
  const cached = getCachedSession(token);
  if (cached) {
    req.actorId = cached.actorId;
    req.tenantId = cached.tenantId;
    req.supabaseClient = getTenantClient(token);
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
    const actorId = user.id;
    const tenantId = await resolveEffectiveTenantId(actorId);
    sessionCache.set(token, { actorId, tenantId, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
    req.actorId = actorId;
    req.tenantId = tenantId;
    req.supabaseClient = getTenantClient(token);
    next();
  } catch (err: any) {
    logger.error({ err: err.message }, '[AUTH] Error inesperado en tenantAuthMiddleware (posible timeout de red hacia Supabase)');
    return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación.' });
  }
}
