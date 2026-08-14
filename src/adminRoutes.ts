import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { supabase } from './services/supabase';
import { config } from './config/env';
import { logger } from './services/logger';
import { withTimeout } from './utils/withTimeout';
import { createRateLimiter } from './utils/rateLimit';
import { getClientIp } from './utils/clientIp';
import { isValidUUID } from './utils/idValidation';
import { resolvePropertyZoneInfo } from './services/zonesService';
import {
  ADMIN_SESSION_COOKIE,
  adminAuthMiddleware,
  isAllowedAdminEmail,
  isAllowedAdminUser,
  clearAdminSessionCache
} from './adminAuth';

const adminDashboardPath = fs.existsSync(path.join(__dirname, 'admin-dashboard'))
  ? path.join(__dirname, 'admin-dashboard')
  : path.join(process.cwd(), 'src', 'admin-dashboard');

const adminAuthRateLimiter = createRateLimiter(5, 60_000);
const PROPERTIES_PAGE_SIZE = 50;

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

  adminRouter.use(express.json());

  // --- Auth (públicos, dentro del propio host admin) ---

  adminRouter.post('/api/auth/request-magic-link', async (req, res) => {
    const ip = getClientIp(req);
    const { email } = req.body ?? {};

    if (!adminAuthRateLimiter.check(ip)) {
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

      const redirectTo = config.adminAppUrl || `https://${config.adminHost}`;
      const { error }: any = await withTimeout(
        supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } }),
        10_000,
        'Supabase signInWithOtp (admin)'
      );
      if (error) {
        logger.error({ ip, email, supabaseError: error.message }, '[ADMIN AUTH] Supabase rechazó el magic link admin');
      } else {
        logger.info({ ip, email }, '[ADMIN AUTH] Magic link admin enviado');
      }
      return res.json(genericResponse);
    } catch (err: any) {
      logger.error({ ip, email, err: err.message }, '[ADMIN AUTH] Error inesperado solicitando magic link admin');
      return res.json(genericResponse);
    }
  });

  adminRouter.post('/api/auth/exchange-token', async (req, res) => {
    const { access_token } = req.body ?? {};
    if (!access_token) return res.status(400).json({ error: 'Token requerido.' });

    try {
      const { data: { user }, error }: any = await withTimeout(
        supabase.auth.getUser(access_token), 10_000, 'Supabase getUser (admin exchange-token)'
      );
      if (error || !user) {
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
      res.cookie(ADMIN_SESSION_COOKIE, access_token, {
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

  adminRouter.get('/api/metrics', adminAuthMiddleware, async (_req, res) => {
    try {
      const [propertiesCount, profilesCount, matchesCount, activeSearches] = await Promise.all([
        supabase.from('properties').select('id', { count: 'exact', head: true }),
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('blind_matches').select('id', { count: 'exact', head: true }),
        supabase.from('active_searches').select('tenant_id').eq('status', 'active')
      ]);

      const failures = [propertiesCount, profilesCount, matchesCount, activeSearches].filter((r: any) => r.error);
      if (failures.length > 0) {
        logger.error({ errors: failures.map((f: any) => f.error?.message) }, '[ADMIN] Error calculando métricas');
        return res.status(500).json({ error: 'No se pudieron calcular las métricas.' });
      }

      const activeTenants = new Set((activeSearches.data ?? []).map((r: any) => r.tenant_id)).size;

      res.json({
        totalMatches: matchesCount.count ?? 0,
        registeredUsers: profilesCount.count ?? 0,
        activeUsers: activeTenants,
        activeUsersDefinition: 'Tenants con al menos una búsqueda activa (active_searches.status = \'active\')',
        totalProperties: propertiesCount.count ?? 0,
        mrr: null,
        churn: null,
        billingNote: 'Pendiente — sin cobros integrados todavía.'
      });
    } catch (err: any) {
      logger.error({ err: err.message }, '[ADMIN] Error inesperado calculando métricas');
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  adminRouter.get('/api/properties', adminAuthMiddleware, async (req, res) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const from = (page - 1) * PROPERTIES_PAGE_SIZE;
      const to = from + PROPERTIES_PAGE_SIZE - 1;

      let query = supabase
        .from('properties')
        .select('id, address, sheet_name, features, latitude, longitude, tenant_id', { count: 'exact' })
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
      const properties = await Promise.all(rows.map(async (p: any) => {
        const zoneInfo = await resolvePropertyZoneInfo({
          latitude: p.latitude,
          longitude: p.longitude,
          address: p.address,
          features: p.features ?? undefined,
          sheet_name: p.sheet_name
        });
        return {
          id: p.id,
          address: p.address,
          latitude: p.latitude,
          longitude: p.longitude,
          zone: zoneInfo.zone,
          zoneSource: zoneInfo.source,
          textSuggestedZone: zoneInfo.textSuggestedZone,
          hasDiscrepancy: zoneInfo.hasDiscrepancy
        };
      }));

      res.json({ properties, page, pageSize: PROPERTIES_PAGE_SIZE, total: count ?? 0 });
    } catch (err: any) {
      logger.error({ err: err.message }, '[ADMIN] Error inesperado listando propiedades');
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  adminRouter.patch('/api/properties/:id/coordinates', adminAuthMiddleware, async (req, res) => {
    const { id } = req.params;
    const { latitude, longitude } = req.body ?? {};
    const admin = (req as any).admin as { adminUserId: string; email: string };

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Id de propiedad inválido.' });
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

      const { error: updateError } = await supabase
        .from('properties')
        .update({ latitude, longitude })
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

      logger.info({ adminEmail: admin.email, propertyId: id, before, after }, '[ADMIN] Coordenadas de propiedad corregidas');
      res.json({ success: true, latitude, longitude, zone: zoneInfo.zone, zoneSource: zoneInfo.source });
    } catch (err: any) {
      logger.error({ err: err.message, id }, '[ADMIN] Error inesperado corrigiendo coordenadas');
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  // --- Frontend estático del panel ---

  const adminIndexHtmlPath = path.join(adminDashboardPath, 'index.html');
  if (fs.existsSync(adminIndexHtmlPath)) {
    const adminIndexHtml = fs.readFileSync(adminIndexHtmlPath, 'utf-8');
    adminRouter.get(['/', '/index.html'], (req, res) => {
      // res.locals.cspNonce ya lo fija el middleware global de src/index.ts (antes de que la
      // request llegue acá), consumido también por la directiva CSP de Helmet — mismo patrón
      // que usa el dashboard de tenants para el script de tema.
      const html = adminIndexHtml.replace(/__CSP_NONCE__/g, res.locals.cspNonce);
      res.type('html').send(html);
    });
  }
  adminRouter.use(express.static(adminDashboardPath));

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
