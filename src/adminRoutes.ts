import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabase } from './services/supabase';
import { config } from './config/env';
import { logger } from './services/logger';
import { withTimeout } from './utils/withTimeout';
import { createDistributedRateLimiter } from './utils/rateLimit';
import { getClientIp } from './utils/clientIp';
import { isValidUUID } from './utils/idValidation';
import { JSON_BODY_SIZE_LIMIT, jsonBodyParseErrorHandler, validateBodyWhitelist } from './utils/bodyWhitelist';
import {
  resolvePropertyZoneInfo,
  resolvePropertiesZoneInfoBatch,
  findNeighborhoodsForPoints,
  PropertyForZoneBatch,
  ZonePointInput
} from './services/zonesService';
import {
  ADMIN_SESSION_COOKIE,
  adminAuthMiddleware,
  isAllowedAdminEmail,
  isAllowedAdminUser,
  clearAdminSessionCache
} from './adminAuth';
import { sendAdminMagicLinkEmail } from './services/notifier-email';

// KAN-127: distribuido (Postgres) — el panel admin puede correr detrás de más de una instancia
// igual que el resto de la app, ver src/utils/rateLimit.ts.
const adminAuthRateLimiter = createDistributedRateLimiter('admin-auth', 5, 60_000);
// KAN-131: revisión de la infraestructura existente — createDistributedRateLimiter (KAN-127) ya
// existía y se usaba en admin-auth (endpoint público, sin sesión, por IP), pero ningún endpoint
// autenticado del panel admin (/api/metrics, /api/properties, /api/zones,
// /api/properties/:id/coordinates) tenía rate limiting propio. Este ticket cubre puntualmente
// GET /api/metrics (alcance de los acceptance criteria); por identidad (adminUserId) en vez de
// IP, mismo criterio que search/upload en config/env.ts.
const adminMetricsRateLimiter = createDistributedRateLimiter(
  'admin-metrics',
  config.metricsRateLimitMax,
  config.metricsRateLimitWindowMs
);
// KAN-277: mismo mecanismo (por adminUserId) que adminMetricsRateLimiter, extendido al resto de
// las rutas autenticadas del panel admin que quedaron sin cubrir cuando KAN-131 cerró puntualmente
// GET /api/metrics — GET /api/properties, POST /api/zones y PATCH /api/properties/:id/coordinates.
const adminApiRateLimiter = createDistributedRateLimiter(
  'admin-api',
  config.metricsRateLimitMax,
  config.metricsRateLimitWindowMs
);
const PROPERTIES_PAGE_SIZE = 50;

// KAN-276: hasta ahora solo la corrección de coordenadas quedaba auditada en admin_audit_log —
// las lecturas de /api/metrics y /api/properties (que exponen datos de todos los tenants a través
// de la clave service-role) no dejaban rastro. Fire-and-forget: la auditoría no debe afectar la
// latencia ni la disponibilidad del endpoint que audita.
function logAdminRead(adminUserId: string, action: string): void {
  supabase
    .from('admin_audit_log')
    .insert({ admin_user_id: adminUserId, action })
    .then(({ error }) => {
      if (error) {
        logger.error({ err: error.message, action }, '[ADMIN] No se pudo escribir el audit log de lectura');
      }
    });
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Monta el panel admin (app.admin.brokaza.com) como una rama completamente separada del
 * pipeline de Express: solo se ejecuta cuando el Host de la request coincide con
 * config.adminHost, y su propio catch-all al final devuelve 404 en vez de hacer next() —
 * así el tráfico del panel admin nunca cae en el dashboard/API de tenants, y viceversa.
 * Sin ADMIN_HOST seteada, esta función no registra nada (panel deshabilitado por completo).
 */
export function mountAdminRouter(app: express.Application): void {
  if (!config.adminHost) {
    logger.info('[ADMIN] ADMIN_HOST no está configurada — panel admin deshabilitado.');
    return;
  }

  const adminRouter = express.Router();

  // KAN-134: mismo límite explícito + traducción de errores de body-parser que el pipeline
  // principal de tenants (src/index.ts) — ver src/utils/bodyWhitelist.ts.
  adminRouter.use(express.json({ limit: JSON_BODY_SIZE_LIMIT }));
  adminRouter.use(jsonBodyParseErrorHandler);

  // --- Auth (públicos, dentro del propio host admin) ---

  adminRouter.post('/api/auth/request-magic-link', async (req, res) => {
    const ip = getClientIp(req);
    const { email } = req.body ?? {};

    if (!(await adminAuthRateLimiter.check(ip))) {
      return res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto e intentá de nuevo.' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Email inválido.' });
    }

    // Respuesta genérica siempre, esté o no el email en la allowlist — evita que alguien pueda
    // enumerar qué cuentas son admin probando emails contra este endpoint.
    const genericResponse = { success: true, message: 'Si el email está autorizado, vas a recibir un link de acceso.' };

    try {
      const allowed = await isAllowedAdminEmail(email);
      if (!allowed) {
        logger.warn({ ip, email }, '[ADMIN AUTH] Intento de magic link con email fuera de la allowlist');
        return res.json(genericResponse);
      }

      // KAN-342 (bug encontrado en vivo, primer intento de fix): sin el `/admin` explícito, el
      // `action_link` hosteado por Supabase (`redirectTo`) caía en la raíz del origen — pero el
      // problema real resultó más profundo: Supabase solo respeta `redirectTo` si esa URL está en
      // el allow-list de "Redirect URLs" de su dashboard (Authentication → URL Configuration); sin
      // eso configurado, cae en silencio a la Site URL (la del tenant), sin importar qué le
      // mandemos acá. En vez de depender de esa config externa (y de que alguien la mantenga
      // sincronizada con el dominio real en cada entorno), dejamos de usar `action_link`
      // (el redirect hosteado de Supabase) del todo: mandamos nuestro propio link con el
      // `hashed_token` que `generateLink` ya devuelve, y lo canjeamos nosotros mismos server-side
      // con `verifyOtp` más abajo — la única URL que Supabase necesita conocer es la del propio
      // proyecto (fija, no depende de `ADMIN_APP_URL`/`ADMIN_HOST` por entorno).
      const redirectBase = (config.adminAppUrl || `https://${config.adminHost}`).replace(/\/+$/, '');
      const redirectTo = `${redirectBase}/admin`;
      // 2026-08-22: mismo cambio que el tenant (src/routes/auth.ts) — Supabase ya no manda el
      // email (su template único no puede tener copy propio para admin), generamos el link y lo
      // mandamos nosotros por Resend con el template de admin.
      const { data, error }: any = await withTimeout(
        supabase.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } }),
        10_000,
        'Supabase generateLink (admin)'
      );
      if (error) {
        logger.error({ ip, email, supabaseError: error.message }, '[ADMIN AUTH] Supabase rechazó la generación del magic link admin');
        return res.json(genericResponse);
      }

      const hashedToken = data?.properties?.hashed_token;
      if (!hashedToken) {
        logger.error({ ip, email }, '[ADMIN AUTH] Supabase generateLink no devolvió hashed_token (admin)');
        return res.json(genericResponse);
      }

      const ownLink = `${redirectTo}?token_hash=${encodeURIComponent(hashedToken)}&type=magiclink`;
      const sent = await sendAdminMagicLinkEmail(email, ownLink);
      if (!sent) {
        logger.error({ ip, email }, '[ADMIN AUTH] No se pudo enviar el email de magic link admin');
      } else {
        logger.info({ ip, email }, '[ADMIN AUTH] Magic link admin enviado');
      }
      return res.json(genericResponse);
    } catch (err: any) {
      logger.error({ ip, email, err: err.message }, '[ADMIN AUTH] Error inesperado solicitando magic link admin');
      return res.json(genericResponse);
    }
  });

  // KAN-342: pasa de recibir un `access_token` ya emitido (parseado por el frontend del hash
  // `#access_token=...` que devolvía el redirect hosteado de Supabase) a recibir el `token_hash`
  // que nosotros mismos pusimos en el link del email (ver request-magic-link arriba) y canjearlo
  // acá con `verifyOtp` — la validación contra Supabase pasa a ser explícita en este único punto,
  // en vez de depender de que el redirect hosteado de Supabase haya llegado a la URL correcta.
  adminRouter.post('/api/auth/exchange-token', async (req, res) => {
    const { token_hash, type } = req.body ?? {};
    if (!token_hash || typeof token_hash !== 'string') {
      return res.status(400).json({ error: 'Token requerido.' });
    }
    // Único tipo que este endpoint espera — no se acepta ningún otro `type` de OTP de Supabase
    // (signup/recovery/invite/etc.) aunque el llamador lo pida, este endpoint es solo para el
    // magic link de admin.
    if (type !== 'magiclink') {
      return res.status(400).json({ error: 'Tipo de token inválido.' });
    }

    try {
      // BUG REAL encontrado en vivo (KAN-342): `verifyOtp` es una operación de login — al llamarla
      // sobre el singleton `supabase` (service-role, importado de `services/supabase.ts` y
      // COMPARTIDO por toda la app) deja el session interno del cliente seteado al usuario recién
      // logueado (`role: authenticated`, no `service_role`) para SIEMPRE, no solo para esta
      // request. Confirmado con los logs de Supabase (Authentication → Logs / edge_logs): el
      // header `Authorization` de la request siguiente (`isAllowedAdminUser` de más abajo) salía
      // con el JWT del admin logueado en vez de la service-role key, así que `admin_users` (RLS
      // deny-all) le devolvía 0 filas — no por falta de permisos reales, sino porque el propio
      // canje de token pisaba la identidad del cliente compartido. `supabase.auth.getUser(token)`
      // (lo que usaba el código viejo) NO tiene este problema — es una verificación sin estado, no
      // hace login. Fix: `verifyOtp` corre en un cliente descartable propio (anon key, el mismo
      // criterio que un login normal de usuario), nunca en el singleton service-role.
      const otpClient = createClient(config.supabaseUrl!, config.supabaseAnonKey!, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
      const { data: { session, user }, error }: any = await withTimeout(
        otpClient.auth.verifyOtp({ token_hash, type: 'magiclink' }),
        10_000,
        'Supabase verifyOtp (admin exchange-token)'
      );
      if (error || !session || !user) {
        return res.status(401).json({ error: 'Token inválido o expirado.' });
      }

      const identity = await isAllowedAdminUser(user.id);
      if (!identity) {
        logger.warn({ userId: user.id, email: user.email }, '[ADMIN AUTH] exchange-token de usuario fuera de la allowlist');
        return res.status(403).json({ error: 'No autorizado.' });
      }

      // secure: false solo cuando ADMIN_APP_URL apunta explícitamente a http (dev local sin TLS) —
      // en producción (sin ADMIN_APP_URL, o con https) la cookie exige HTTPS, igual que
      // brokaza_session para tenants (ver src/index.ts).
      const isLocalHttp = !!config.adminAppUrl && config.adminAppUrl.startsWith('http://');
      res.cookie(ADMIN_SESSION_COOKIE, session.access_token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: !isLocalHttp,
        maxAge: 12 * 60 * 60 * 1000
      });
      return res.json({ success: true, admin: { email: identity.email } });
    } catch (err: any) {
      logger.error({ err: err.message }, '[ADMIN AUTH] Error inesperado en exchange-token admin');
      return res.status(500).json({ error: 'Error interno.' });
    }
  });

  adminRouter.get('/api/auth/session', async (req, res) => {
    const token = req.cookies?.[ADMIN_SESSION_COOKIE];
    if (!token) return res.json({ authenticated: false });

    try {
      const { data: { user }, error }: any = await withTimeout(
        supabase.auth.getUser(token), 10_000, 'Supabase getUser (admin session)'
      );
      if (error || !user) {
        res.clearCookie(ADMIN_SESSION_COOKIE);
        return res.json({ authenticated: false });
      }
      const identity = await isAllowedAdminUser(user.id);
      if (!identity) {
        res.clearCookie(ADMIN_SESSION_COOKIE);
        return res.json({ authenticated: false });
      }
      return res.json({ authenticated: true, admin: { email: identity.email } });
    } catch (err: any) {
      logger.error({ err: err.message }, '[ADMIN AUTH] Error inesperado verificando sesión admin');
      return res.status(500).json({ authenticated: false });
    }
  });

  adminRouter.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.[ADMIN_SESSION_COOKIE];
    if (token) clearAdminSessionCache(token);
    res.clearCookie(ADMIN_SESSION_COOKIE);
    res.json({ success: true });
  });

  // --- API autenticada ---

  adminRouter.get('/api/metrics', adminAuthMiddleware, async (req, res) => {
    const admin = req.admin as { adminUserId: string; email: string };

    if (!(await adminMetricsRateLimiter.check(admin.adminUserId))) {
      return res.status(429).json({ error: 'Demasiadas solicitudes de métricas. Esperá un minuto e intentá de nuevo.' });
    }

    logAdminRead(admin.adminUserId, 'read_metrics');

    try {
      const [propertiesCount, profileIds, matchesCount, activeSearches, everSearchedTenants] = await Promise.all([
        supabase.from('properties').select('id', { count: 'exact', head: true }),
        // KAN-59 (fix de QA): antes se pedía profilesCount con head:true; ahora se necesita la
        // lista real de tenant_id para poder chequear cartera por tenant sin traer `properties`
        // entera. Nota (2026-09-04): esto asumía un "tope duro de 10 tenants" que nunca existió
        // como enforcement real (ver .agent/CONTEXT.md#2) — sin límite de registro de corredores,
        // este loop de N queries (una por tenant, más abajo) escala linealmente con la cantidad
        // real de tenants, no con un techo fijo. Revisar si se vuelve un problema de performance
        // en `/api/metrics` a medida que crece la base de tenants.
        supabase.from('profiles').select('id'),
        supabase.from('blind_matches').select('id', { count: 'exact', head: true }),
        supabase.from('active_searches').select('tenant_id').eq('status', 'active'),
        // `active_searches` sí es seguro pedirla completa (sin head:true) para sacar el distinct de
        // tenant_id en JS — expira a los 7 días (trigger `set_active_searches_expires_at`), nunca
        // acumula sin límite como `properties`. Sin filtro de status a propósito: a diferencia de
        // activeSearches (arriba, solo 'active'), esto es "alguna vez hizo una búsqueda", así que
        // cuenta también las expiradas/matcheadas/canceladas.
        supabase.from('active_searches').select('tenant_id')
      ]);

      const failures = [propertiesCount, profileIds, matchesCount, activeSearches, everSearchedTenants].filter((r: any) => r.error);
      if (failures.length > 0) {
        logger.error({ errors: failures.map((f: any) => f.error?.message) }, '[ADMIN] Error calculando métricas');
        return res.status(500).json({ error: 'No se pudieron calcular las métricas.' });
      }

      // KAN-59 (fix de QA): a diferencia de la primera versión, que traía toda la tabla
      // `properties` (sin bound — el catálogo de cada agencia puede tener cientos/miles de filas),
      // acá se hacen N counts indexados y livianos (`head: true`, cero filas transferidas) — uno
      // por tenant — y se cuenta cuántos tienen al menos una propiedad. Escala con la cantidad de
      // tenants, no con el tamaño del catálogo — pero sin un techo real de tenants (ver nota más
      // arriba) este `Promise.all` crece linealmente con el número de registros; si la cantidad de
      // tenants deja de ser chica conviene reemplazarlo por una sola query agregada.
      const portfolioChecksPerTenant = await Promise.all(
        (profileIds.data ?? []).map((p: any) =>
          supabase.from('properties').select('id', { count: 'exact', head: true }).eq('tenant_id', p.id)
        )
      );
      const portfolioCheckFailures = portfolioChecksPerTenant.filter((r: any) => r.error);
      if (portfolioCheckFailures.length > 0) {
        logger.error(
          { errors: portfolioCheckFailures.map((f: any) => f.error?.message) },
          '[ADMIN] Error calculando agentsWithPortfolio'
        );
        return res.status(500).json({ error: 'No se pudieron calcular las métricas.' });
      }

      const activeTenants = new Set((activeSearches.data ?? []).map((r: any) => r.tenant_id)).size;
      const agentsWithPortfolio = portfolioChecksPerTenant.filter((r: any) => (r.count ?? 0) > 0).length;
      const agentsWithSearch = new Set((everSearchedTenants.data ?? []).map((r: any) => r.tenant_id)).size;

      res.json({
        totalMatches: matchesCount.count ?? 0,
        registeredUsers: profileIds.data?.length ?? 0,
        activeUsers: activeTenants,
        activeUsersDefinition: 'Tenants con al menos una búsqueda activa (active_searches.status = \'active\')',
        totalProperties: propertiesCount.count ?? 0,
        // KAN-59: panel de salud del piloto — agentes con cartera cargada y agentes con al menos
        // una búsqueda realizada (histórico, no solo activas), sumados a totalMatches de arriba.
        agentsWithPortfolio,
        agentsWithSearch,
        mrr: null,
        churn: null,
        billingNote: 'Pendiente — sin cobros integrados todavía.'
      });
    } catch (err: any) {
      logger.error({ err: err.message }, '[ADMIN] Error inesperado calculando métricas');
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  // KAN-130: antes acá había un patrón N+1 — por cada propiedad de la página se llamaba
  // resolvePropertyZoneInfo(), que a su vez podía disparar hasta 2 round-trips a Postgres. Con
  // hasta 50 propiedades por página, eso eran ~100 llamadas a Supabase por carga. Ahora:
  // 1) el SELECT trae el `zone_id` ya cacheado con un join embebido a `neighborhoods` (0 llamadas
  //    extra), y 2) para las filas sin `zone_id` (propiedad nueva, sin corrección de coordenadas
  //    todavía) se resuelven todas juntas con un único RPC batch (`neighborhoods_for_points`).
  // Resultado: 1 (SELECT) + a lo sumo 1 (RPC batch) = 2 llamadas a la base por página, sea cual
  // sea la cantidad de propiedades.
  adminRouter.get('/api/properties', adminAuthMiddleware, async (req, res) => {
    const admin = req.admin as { adminUserId: string; email: string };
    if (!(await adminApiRateLimiter.check(admin.adminUserId))) {
      return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un minuto e intentá de nuevo.' });
    }

    logAdminRead(admin.adminUserId, 'list_properties');

    try {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const from = (page - 1) * PROPERTIES_PAGE_SIZE;
      const to = from + PROPERTIES_PAGE_SIZE - 1;

      let query = supabase
        .from('properties')
        // KAN-305: needs_coordinate_review se agrega acá para que el admin vea qué propiedades
        // tienen un pedido de corrección pendiente del tenant sin tener que cruzarlo a mano.
        .select(
          'id, address, sheet_name, features, latitude, longitude, needs_coordinate_review, tenant_id, zone_id, neighborhoods!properties_zone_id_fkey(id, name, group_id)',
          { count: 'exact' }
        )
        .order('address', { ascending: true })
        .range(from, to);

      if (search) {
        query = query.ilike('address', `%${search}%`);
      }

      const { data, error, count } = await query;
      if (error) {
        logger.error({ err: error.message }, '[ADMIN] Error listando propiedades');
        return res.status(500).json({ error: 'No se pudieron listar las propiedades.' });
      }

      const rows = data ?? [];
      const propertiesForBatch: PropertyForZoneBatch[] = rows.map((p: any) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        address: p.address,
        features: p.features ?? undefined,
        sheet_name: p.sheet_name,
        cachedZone: p.neighborhoods ? { id: p.neighborhoods.id, name: p.neighborhoods.name } : null
      }));

      const zoneInfos = await resolvePropertiesZoneInfoBatch(propertiesForBatch);

      const properties = rows.map((p: any, idx: number) => {
        const zoneInfo = zoneInfos[idx];
        return {
          id: p.id,
          address: p.address,
          latitude: p.latitude,
          longitude: p.longitude,
          needsCoordinateReview: p.needs_coordinate_review,
          zone: zoneInfo.zone,
          zoneSource: zoneInfo.source,
          textSuggestedZone: zoneInfo.textSuggestedZone,
          hasDiscrepancy: zoneInfo.hasDiscrepancy
        };
      });

      res.json({ properties, page, pageSize: PROPERTIES_PAGE_SIZE, total: count ?? 0 });
    } catch (err: any) {
      logger.error({ err: err.message }, '[ADMIN] Error inesperado listando propiedades');
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  // KAN-130: expone el RPC batch de resolución de zonas como endpoint propio — además de
  // consumirlo internamente GET /api/properties, sirve para resolver zonas de un array de
  // coordenadas de forma aislada/testeable (ej. previsualizar la zona de una propiedad antes de
  // guardarla, o herramientas de diagnóstico del panel admin).
  const MAX_ZONE_POINTS_PER_REQUEST = 500;

  adminRouter.post('/api/zones', adminAuthMiddleware, async (req, res) => {
    const zonesAdmin = req.admin as { adminUserId: string; email: string };
    if (!(await adminApiRateLimiter.check(zonesAdmin.adminUserId))) {
      return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un minuto e intentá de nuevo.' });
    }

    // KAN-134: whitelist de campos del body.
    const bodyWhitelistError = validateBodyWhitelist(req.body, ['points']);
    if (bodyWhitelistError) {
      return res.status(400).json({ error: bodyWhitelistError });
    }

    const points = (req.body ?? {}).points;

    if (!Array.isArray(points) || points.length === 0) {
      return res.status(400).json({ error: 'points debe ser un array no vacío de { lat, lon }.' });
    }
    if (points.length > MAX_ZONE_POINTS_PER_REQUEST) {
      return res.status(400).json({ error: `No se pueden resolver más de ${MAX_ZONE_POINTS_PER_REQUEST} puntos por request.` });
    }

    const parsedPoints: ZonePointInput[] = [];
    for (let idx = 0; idx < points.length; idx++) {
      const p = points[idx];
      if (!isFiniteInRange(p?.lat, -90, 90) || !isFiniteInRange(p?.lon, -180, 180)) {
        return res.status(400).json({ error: `Punto inválido en la posición ${idx}: lat/lon deben ser números finitos dentro de rango.` });
      }
      parsedPoints.push({ idx, latitude: p.lat, longitude: p.lon });
    }

    try {
      const resolved = await findNeighborhoodsForPoints(parsedPoints);
      const zones = parsedPoints.map((p) => {
        const match = resolved.get(p.idx);
        return match
          ? { zone: { id: match.id, name: match.name, group_id: match.group_id }, matchType: match.matchType }
          : { zone: null, matchType: null };
      });
      res.json({ zones });
    } catch (err: any) {
      logger.error({ err: err.message }, '[ADMIN] Error resolviendo zonas en batch (POST /api/zones)');
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  adminRouter.patch('/api/properties/:id/coordinates', adminAuthMiddleware, async (req, res) => {
    const { id } = req.params;
    const { latitude, longitude } = req.body ?? {};
    const admin = req.admin as { adminUserId: string; email: string };

    if (!(await adminApiRateLimiter.check(admin.adminUserId))) {
      return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un minuto e intentá de nuevo.' });
    }

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Id de propiedad inválido.' });
    }

    // KAN-134: whitelist de campos del body.
    const bodyWhitelistError = validateBodyWhitelist(req.body, ['latitude', 'longitude']);
    if (bodyWhitelistError) {
      return res.status(400).json({ error: bodyWhitelistError });
    }

    if (!isFiniteInRange(latitude, -90, 90) || !isFiniteInRange(longitude, -180, 180)) {
      return res.status(400).json({ error: 'Latitud/longitud inválidas.' });
    }

    try {
      const { data: existing, error: fetchError } = await supabase
        .from('properties')
        .select('id, address, latitude, longitude, sheet_name, features')
        .eq('id', id)
        .maybeSingle();

      if (fetchError) {
        logger.error({ err: fetchError.message, id }, '[ADMIN] Error buscando propiedad a corregir');
        return res.status(500).json({ error: 'Error interno.' });
      }
      if (!existing) {
        return res.status(404).json({ error: 'Propiedad no encontrada.' });
      }

      const before = { latitude: existing.latitude, longitude: existing.longitude };

      // KAN-305: guardar una corrección real es la señal de que el pedido del tenant (si lo hubo)
      // quedó resuelto — se apaga el flag acá mismo, sin depender de un segundo request separado.
      const { error: updateError } = await supabase
        .from('properties')
        .update({ latitude, longitude, needs_coordinate_review: false })
        .eq('id', id);

      if (updateError) {
        logger.error({ err: updateError.message, id }, '[ADMIN] Error actualizando coordenadas de propiedad');
        return res.status(500).json({ error: 'No se pudo actualizar la propiedad.' });
      }

      const after = { latitude, longitude };

      const { error: auditError } = await supabase.from('admin_audit_log').insert({
        admin_user_id: admin.adminUserId,
        property_id: id,
        action: 'update_coordinates',
        before,
        after
      });
      if (auditError) {
        // No revertimos el update por esto — el audit log es trazabilidad, no la fuente de verdad.
        logger.error({ err: auditError.message, id }, '[ADMIN] No se pudo escribir el audit log de corrección de coordenadas');
      }

      const zoneInfo = await resolvePropertyZoneInfo({
        latitude,
        longitude,
        address: existing.address,
        features: existing.features ?? undefined,
        sheet_name: existing.sheet_name
      });

      // KAN-130: las coordenadas cambiaron, así que el `zone_id` cacheado (si había uno) quedó
      // desactualizado — se refresca acá mismo. Solo se persiste cuando la zona salió de PostGIS
      // (source === 'point'); un match por texto es una sugerencia, no algo que corresponda cachear
      // como "la zona real" de la propiedad (mismo criterio que usa resolvePropertiesZoneInfoBatch
      // al decidir qué cuenta como `cachedZone`).
      const { error: zoneIdUpdateError } = await supabase
        .from('properties')
        .update({ zone_id: zoneInfo.source === 'point' ? zoneInfo.zone!.id : null })
        .eq('id', id);
      if (zoneIdUpdateError) {
        // No bloqueante: la corrección de coordenadas ya se guardó — esto es solo refrescar el
        // caché de lectura, se puede recalcular en la próxima carga de GET /api/properties.
        logger.error({ err: zoneIdUpdateError.message, id }, '[ADMIN] No se pudo refrescar zone_id tras corregir coordenadas');
      }

      logger.info({ adminEmail: admin.email, propertyId: id, before, after }, '[ADMIN] Coordenadas de propiedad corregidas');
      res.json({ success: true, latitude, longitude, zone: zoneInfo.zone, zoneSource: zoneInfo.source });
    } catch (err: any) {
      logger.error({ err: err.message, id }, '[ADMIN] Error inesperado corrigiendo coordenadas');
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  // KAN-342/KAN-258: el frontend estático legacy (`src/admin-dashboard/`, index.html + app.js +
  // style.css + Leaflet vendorizado) se retiró — el panel admin real ahora es
  // `brokaza-frontend/src/app/admin` (Next.js), que le pega a estas mismas rutas de API vía el
  // proxy `/admin/api/*` (ver `next.config.ts` + `admin-api-client.ts`). Este router sigue
  // existiendo únicamente para exponer esas rutas de API bajo `config.adminHost`.

  // Catch-all: cualquier ruta no reconocida del host admin termina acá, nunca hace next() hacia
  // el resto del pipeline (dashboard/API de tenants).
  adminRouter.use((_req, res) => {
    res.status(404).json({ error: 'No encontrado.' });
  });

  app.use((req, res, next) => {
    if (req.hostname === config.adminHost) {
      return adminRouter(req, res, next);
    }
    return next();
  });

  logger.info({ adminHost: config.adminHost }, '[ADMIN] Panel admin montado');
}
