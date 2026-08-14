import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import http from 'http';
import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { Property, processExcelBufferWithColumnMap, peekExcelHeaders, syncPropertiesToDatabase } from './services/excel';
import { resolveColumnMapping, confirmColumnMapping, toColumnMapRecord, ExcelMappingServiceError } from './services/excelMapping';
import { ExcelMappingField } from './utils/excelHeaderMatcher';
import { extractFromTextInput, extractZoneIntent, segmentSearchRequests, ZoneIntentRequest, AITimeoutError } from './services/ai';
import { findCrossTenantMatches } from './services/blindMatching';
import { validateFreeSearchText } from './utils/searchValidation';
import { calculateDaysRemaining } from './utils/activeSearches';
import { validateProfileInput } from './utils/profileValidation';
import { getTucumanLocalities } from './services/localitiesService';
import { isValidUUID } from './utils/idValidation';
import { isValidInternalWebhookSecret } from './utils/internalWebhookAuth';
import { sendWebPushToTenant, buildMatchFoundPushPayload, buildIncomingMatchPushPayload, hasActivePushSubscriptions } from './services/webPush';
import { sendBlindMatchEmailFallback, sendIncomingMatchEmailFallback } from './services/notifier-email';
import { notifyMatchFound } from './services/notifications';
import { processPropertyUploaded } from './services/propertyMatchWebhook';
import { initRealtimeHub, broadcastMatchCountChanged } from './services/realtimeHub';
import { startDolarService } from './services/dolar';
import { startSearchExpirationService } from './services/searchExpiration';
import { config } from './config/env';
import { logger } from './services/logger';
import { withTimeout } from './utils/withTimeout';
import { createRateLimiter } from './utils/rateLimit';
import { getClientIp } from './utils/clientIp';
import { mountAdminRouter } from './adminRoutes';
import { nodeEnvCheckMiddleware } from './utils/nodeEnvCheck';
import { globalErrorHandler } from './utils/errorHandler';
import {
  buildBlindMatchInsertRows,
  mapBlindMatchRowToDashboardShape,
  mapIncomingMatchRowToDashboardShape,
  mapPropertyToBlindMatchShape,
  groupMatchesByMatchedTenant,
  SearcherSnapshot
} from './utils/blindMatchPersistence';

// Express Setup
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
  storage: multer.memoryStorage(),
  // KAN-71: mitigación DoS complementaria al rate limit — sin este límite, memoryStorage()
  // acepta un archivo de cualquier tamaño en memoria del proceso.
  limits: { fileSize: config.uploadMaxFileSizeBytes }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[PROCESO] Promesa no capturada (Unhandled Rejection):', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[PROCESO] Error no controlado (Uncaught Exception):', error);
});

// KAN-124: solo advierte (logger.warn, una vez por proceso) si NODE_ENV no es 'production' — no
// bloquea el arranque, a diferencia de las credenciales de Supabase (KAN-122), porque en
// desarrollo local es normal no tenerla seteada.
app.use(nodeEnvCheckMiddleware);

// KAN-69: nonce por request, consumido tanto por la CSP de Helmet como por el
// script inyectado en el <head> del dashboard (ver ruta '/' más abajo).
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", (_req, res) => `'nonce-${(res as express.Response).locals.cspNonce}'`],
        // Tiles de OpenStreetMap para el mapa interactivo del panel admin (corrección de
        // coordenadas de propiedades) — Leaflet en sí está vendorizado en src/admin-dashboard/vendor
        // (sirve como 'self'), solo las imágenes de los tiles vienen de un host externo.
        'img-src': ["'self'", 'data:', 'https://*.tile.openstreetmap.org']
      }
    }
  })
);
app.use(express.json());
app.use(cookieParser());

// Panel admin (app.admin.brokaza.com): se monta ANTES que el resto del pipeline de tenants
// (access gate, dashboard estático, /api/*) para que, cuando el Host coincide, la request
// quede completamente aislada en su propio router y nunca llegue a la lógica de tenants — y
// viceversa, /admin nunca existe si se le pega desde el dominio normal.
mountAdminRouter(app);

// Servir archivos estáticos del dashboard (soportando dev y prod)
const dashboardPath = fs.existsSync(path.join(__dirname, 'dashboard'))
  ? path.join(__dirname, 'dashboard')
  : path.join(process.cwd(), 'src', 'dashboard');
const dashboardIndexHtml = fs.readFileSync(path.join(dashboardPath, 'index.html'), 'utf-8');

// Gate temporal de acceso privado (pre-lanzamiento): mientras ACCESS_GATE_CODE esté seteada,
// nadie sin la cookie de acceso puede ver el dashboard ni pegarle a la API. El valor de la
// cookie es un HMAC del código (no el código en texto plano) firmado con internalWebhookSecret,
// así que no se puede forjar sin conocer el código. /internal/* queda afuera porque lo llama el
// trigger de Postgres (pg_net), no un navegador, y ya tiene su propio secreto compartido.
if (config.accessGateCode) {
  const gateCookieName = 'brokaza_access';
  const gateToken = crypto.createHmac('sha256', config.internalWebhookSecret).update(config.accessGateCode).digest('hex');
  const gatePageHtml = fs.readFileSync(path.join(dashboardPath, 'access-gate.html'), 'utf-8');

  app.use((req, res, next) => {
    if (req.path.startsWith('/internal/')) return next();

    const queryCode = typeof req.query.access === 'string' ? req.query.access : undefined;
    if (queryCode === config.accessGateCode) {
      res.cookie(gateCookieName, gateToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.appUrl.startsWith('https'),
        maxAge: 30 * 24 * 60 * 60 * 1000
      });
      return res.redirect(req.path);
    }

    if (req.cookies?.[gateCookieName] === gateToken) return next();

    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ error: 'Aplicación en acceso privado.' });
    }
    return res.status(503).type('html').send(gatePageHtml);
  });
}

// KAN-69: el script que fija el tema (public/scripts/themeSetter.js) necesita el
// nonce de la request para pasar la CSP — express.static no puede inyectarlo,
// así que el index.html se sirve con esta ruta dedicada, antes del static del dashboard.
app.get(['/', '/index.html'], (req, res) => {
  const html = dashboardIndexHtml.replace(
    '<script src="/scripts/themeSetter.js"></script>',
    `<script src="/scripts/themeSetter.js" nonce="${res.locals.cspNonce}"></script>`
  );
  res.type('html').send(html);
});

app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.static(dashboardPath));

// Rate limiter en memoria para endpoints de auth (max 5 req/min por IP)
const authRateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    authRateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

// KAN-71: rate limit por tenantId (no por IP) para POST /api/search y POST /api/upload — ambos
// ya están detrás de tenantAuthMiddleware, así que la identidad estable a limitar es el tenant,
// no la IP. Ver src/utils/rateLimit.ts y src/config/env.ts para los límites/ventanas.
const searchRateLimiter = createRateLimiter(config.searchRateLimitMax, config.searchRateLimitWindowMs);
const uploadRateLimiter = createRateLimiter(config.uploadRateLimitMax, config.uploadRateLimitWindowMs);

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

function clearCachedSession(token: string) {
  sessionCache.delete(token);
}

async function tenantAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const { supabase, getTenantClient } = require('./services/supabase');
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

// KAN-122: público y sin dependencia de Supabase a propósito — es justamente lo que el frontend
// consulta para saber si Supabase está mal configurado (ALLOW_MISSING_SUPABASE_CREDENTIALS=true
// en desarrollo) antes de intentar cualquier otra cosa. En el caso normal (todas las credenciales
// presentes) devuelve una lista vacía y el dashboard sigue su flujo de siempre.
app.get('/api/system/config-status', (req, res) => {
  res.json({ missingSupabaseCredentials: config.missingSupabaseCredentials });
});

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN (PÚBLICOS)
// ==========================================

app.get('/api/auth/session', async (req, res) => {
  const token = req.cookies?.brokaza_session;
  if (!token) return res.json({ authenticated: false });
  try {
    const { supabase } = require('./services/supabase');
    const { data: { user }, error }: any = await withTimeout(
      supabase.auth.getUser(token), 10_000, 'Supabase getUser (session)'
    );
    if (error?.name === 'AuthRetryableFetchError') {
      // No desloguear al usuario por un fallo transitorio de red/TLS hacia Supabase.
      logger.error({ supabaseError: error.message, cause: error.cause }, '[AUTH] No se pudo conectar con Supabase al chequear /session');
      return res.status(503).json({ authenticated: false, error: 'No pudimos conectar con el servidor de autenticación.' });
    }
    if (error || !user) {
      logger.warn({ supabaseError: error?.message }, '[AUTH] Sesión inválida o expirada al chequear /session');
      res.clearCookie('brokaza_session');
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, tenant: { id: user.id, email: user.email } });
  } catch (err: any) {
    logger.error({ err: err.message }, '[AUTH] Error inesperado al verificar sesión');
    res.status(500).json({ authenticated: false, error: 'Error interno al verificar la sesión.' });
  }
});

app.post('/api/auth/request-magic-link', async (req, res) => {
  const ip = getClientIp(req);
  const { email } = req.body;
  logger.info({ ip, email }, '[AUTH] Solicitud de magic link recibida');

  if (!checkAuthRateLimit(ip)) {
    logger.warn({ ip, email }, '[AUTH] Rate limit excedido en solicitud de magic link');
    return res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto e intentá de nuevo.' });
  }
  if (!email || !String(email).includes('@')) {
    logger.warn({ ip, email }, '[AUTH] Email inválido en solicitud de magic link');
    return res.status(400).json({ error: 'Email inválido.' });
  }

  try {
    const { supabase } = require('./services/supabase');
    const { config } = require('./config/env');
    const { error }: any = await withTimeout(
      supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: config.appUrl } }),
      10_000,
      'Supabase signInWithOtp'
    );
    if (error) {
      // AuthRetryableFetchError = Supabase no fue alcanzable (red/TLS/DNS), no un rechazo real del
      // pedido; en ese caso el mensaje del SDK ("fetch failed") no es apto para mostrar al usuario.
      if (error.name === 'AuthRetryableFetchError') {
        logger.error({ ip, email, supabaseError: error.message, cause: error.cause }, '[AUTH] No se pudo conectar con Supabase para enviar el magic link');
        return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
      }
      logger.warn({ ip, email, supabaseError: error.message }, '[AUTH] Supabase rechazó la solicitud de magic link');
      return res.status(400).json({ error: error.message });
    }
    logger.info({ ip, email }, '[AUTH] Magic link enviado exitosamente');
    res.json({ success: true, message: 'Revisá tu email. Te enviamos un link de acceso.' });
  } catch (err: any) {
    logger.error({ ip, email, err: err.message, stack: err.stack }, '[AUTH] Error inesperado al solicitar magic link (posible timeout o fallo de red hacia Supabase)');
    res.status(500).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
  }
});

app.post('/api/auth/exchange-token', async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Token requerido.' });
  try {
    const { supabase } = require('./services/supabase');
    const { data: { user }, error }: any = await withTimeout(
      supabase.auth.getUser(access_token), 10_000, 'Supabase getUser (exchange-token)'
    );
    if (error?.name === 'AuthRetryableFetchError') {
      logger.error({ supabaseError: error.message, cause: error.cause }, '[AUTH] No se pudo conectar con Supabase al intercambiar el token');
      return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
    }
    if (error || !user) {
      logger.warn({ supabaseError: error?.message }, '[AUTH] Token inválido o expirado en exchange-token');
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }
    // Crear perfil en primera sesión si no existe (full_name/email son NOT NULL en la tabla).
    // KAN-90: full_name arranca vacío a propósito — antes se autocompletaba con el local-part
    // del email (`user.email.split('@')[0]`), lo que dejaba nombres reales truncados/falsos
    // ("juan.perez" en vez de "Juan Pérez") sin que el usuario lo notara. Ahora se le pide
    // explícitamente en el formulario de completar perfil (POST /api/profile más abajo), igual
    // que ya pasa con telefono/inmobiliaria/ciudad/pais.
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: user.id,
      email: user.email,
      full_name: ''
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (profileError) {
      logger.error({ tenantId: user.id, err: profileError.message }, '[AUTH] Error al crear/actualizar perfil');
    }
    res.cookie('brokaza_session', access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    logger.info({ tenantId: user.id, email: user.email }, '[AUTH] Sesión establecida vía magic link');
    res.json({ authenticated: true, tenant: { id: user.id, email: user.email } });
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, '[AUTH] Error inesperado al intercambiar token (posible timeout o fallo de red hacia Supabase)');
    res.status(500).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.brokaza_session;
  if (token) clearCachedSession(token);
  res.clearCookie('brokaza_session');
  res.json({ success: true });
});

// ==========================================
// ENDPOINTS DE PERFIL DE TENANT (KAN-64)
// ==========================================
// Con el retiro de WhatsApp/Baileys como canal de entrada, el agente inmobiliario completa su
// perfil (telefono, inmobiliaria, ciudad, pais) despues del magic link, no via WhatsApp OTP.

// KAN-93: única fuente de valores para el combobox de "Ciudad" del formulario de perfil —
// alcance geográfico fijo a Tucumán (decisión de negocio, ver .agent/CONTEXT.md), nunca un
// listado de otras provincias/países. Protegido por auth igual que el resto de /api/profile,
// aunque no dependa de datos del tenant — es contenido de referencia mostrado dentro del overlay
// de perfil, que solo aparece después del magic link.
app.get('/api/localities/tucuman', tenantAuthMiddleware, async (req, res) => {
  try {
    const localities = await getTucumanLocalities();
    res.json({ localities });
  } catch (error: any) {
    logger.error({ error: error.message || error }, '[PERFIL] Error inesperado al obtener localidades de Tucumán');
    res.status(500).json({ error: 'Error interno al obtener las localidades.' });
  }
});

app.get('/api/profile', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;

  try {
    const { data: profile, error } = await tenantSupabase
      .from('profiles')
      .select('id, full_name, email, phone_number, agency_name, city, country, profile_completed, created_at')
      .eq('id', tenantId)
      .single();

    if (error) throw error;

    res.json({ profile });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[PERFIL] Error al obtener el perfil del tenant');
    res.status(500).json({ error: error.message || 'Error interno al obtener el perfil.' });
  }
});

app.post('/api/profile', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  // KAN-90: first_name/last_name no tienen columnas propias en `profiles` (solo existe
  // `full_name`, un campo combinado desde SPEC-0012) — se piden separados en el formulario para
  // que queden marcados como dos campos obligatorios distintos (AC1), y acá se combinan en
  // `full_name` al persistir, sin necesidad de una migración de schema para este fix.
  // KAN-93: `country` ya NO se acepta del cliente — el negocio fija Argentina como único país
  // habilitado hasta tener un producto local sólido (decisión documentada en .agent/CONTEXT.md),
  // así que se hardcodea acá en vez de confiar en lo que mande el body (defensa en profundidad,
  // ni un payload manipulado puede setear otro país).
  const { first_name, last_name, phone_number, agency_name, city } = req.body;

  const validationError = validateProfileInput({ first_name, last_name, phone_number, agency_name, city });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const fullName = `${(first_name as string).trim()} ${(last_name as string).trim()}`.trim();
    const { data: profile, error } = await tenantSupabase
      .from('profiles')
      .update({
        full_name: fullName,
        phone_number: (phone_number as string).trim(),
        agency_name: (agency_name as string).trim(),
        city: (city as string).trim(),
        country: 'Argentina',
        profile_completed: true
      })
      .eq('id', tenantId)
      .select('id, full_name, email, phone_number, agency_name, city, country, profile_completed, created_at')
      .single();

    if (error) throw error;

    res.json({ success: true, profile });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[PERFIL] Error al actualizar el perfil del tenant');
    res.status(500).json({ error: error.message || 'Error interno al actualizar el perfil.' });
  }
});

// ==========================================
// ENDPOINTS DE API PROTEGIDOS POR IP (TENANT)
// ==========================================

app.post('/api/upload', tenantAuthMiddleware, (req, res, next) => {
  // KAN-71: rate limit por tenant antes de invertir tiempo/memoria en parsear el archivo.
  const tenantId = (req as any).tenantId;
  if (!uploadRateLimiter.check(tenantId)) {
    logger.warn({ tenantId }, '[UPLOAD] Rate limit excedido en POST /api/upload');
    return res.status(429).json({ error: 'Demasiadas subidas de archivo. Esperá un minuto e intentá de nuevo.' });
  }
  next();
}, (req, res, next) => {
  // KAN-71: upload.single() envuelto a mano (en vez de pasarlo directo como middleware) para
  // poder capturar el error de multer si el archivo supera uploadMaxFileSizeBytes y responder
  // 413 con un mensaje claro, en vez de dejar que reviente como un 500 genérico sin manejar.
  upload.single('excelFile')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMb = Math.floor(config.uploadMaxFileSizeBytes / (1024 * 1024));
        return res.status(413).json({ error: `El archivo supera el tamaño máximo permitido (${maxMb}MB).` });
      }
      logger.error({ error: err.message, tenantId: (req as any).tenantId }, '[UPLOAD] Error de multer al procesar el archivo subido');
      return res.status(400).json({ error: 'No se pudo procesar el archivo subido.' });
    }
    next();
  });
}, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  try {
    // KAN-84: antes de parsear el archivo completo, resolvemos el mapeo de columnas de cada hoja
    // (mapeo confirmado ya guardado -> heurística de keywords -> IA como re-detección) — si
    // alguna hoja no llega a confianza suficiente, no se procesa nada todavía: se le devuelve al
    // frontend la propuesta de mapeo para que el agente la confirme o corrija (AC4).
    const sheetsHeaders = peekExcelHeaders(req.file.buffer);
    if (sheetsHeaders.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    const mappingsBySignature = new Map<string, Partial<Record<ExcelMappingField, string | null>>>();
    const pendingConfirmations: any[] = [];

    for (const { sheetName, headers } of sheetsHeaders) {
      const resolution = await resolveColumnMapping(tenantId, headers, tenantSupabase);
      if (resolution.status === 'needs_confirmation') {
        pendingConfirmations.push({
          sheetName,
          headers,
          headerSignature: resolution.headerSignature,
          source: resolution.source,
          fields: resolution.fields,
          unresolvedRequiredFields: resolution.unresolvedRequiredFields,
          ambiguousFields: resolution.ambiguousFields
        });
      } else {
        mappingsBySignature.set(resolution.headerSignature, toColumnMapRecord(resolution.fields));
      }
    }

    if (pendingConfirmations.length > 0) {
      logger.warn(
        { tenantId, sheets: pendingConfirmations.map((p: any) => p.sheetName) },
        '[UPLOAD] El mapeo de columnas de una o más hojas requiere confirmación del agente'
      );
      return res.status(200).json({ requiresMappingConfirmation: true, sheets: pendingConfirmations });
    }

    const { properties: catalog, priceParseErrors } = processExcelBufferWithColumnMap(req.file.buffer, mappingsBySignature);
    if (catalog.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    // Aislamiento por tenant
    await syncPropertiesToDatabase(catalog, tenantId, tenantSupabase);

    if (priceParseErrors.length > 0) {
      logger.warn(
        { tenantId, priceParseErrors },
        '[UPLOAD] Filas con precio no parseable detectadas al procesar el Excel'
      );
    }

    res.json({ success: true, count: catalog.length, priceParseErrors });
  } catch (error: any) {
    console.error('Error al procesar subida de Excel:', error);
    res.status(500).json({ error: error.message || 'Error interno al procesar el archivo.' });
  }
});

// KAN-84 (AC4): el agente confirma o corrige, desde la UI, el mapeo de columnas propuesto por
// POST /api/upload cuando este respondió `requiresMappingConfirmation`. Recibe de nuevo el mismo
// archivo (multipart) más un campo de texto `mappings` (JSON: `{ [sheetName]: { [field]: header
// | null } }`, una entrada por cada hoja pendiente) y, si el mapeo confirmado resuelve los campos
// requeridos de cada hoja, persiste el mapeo como confirmado y procesa el archivo completo en la
// misma request — no hace falta un tercer round-trip.
app.post('/api/upload/confirm-mapping', tenantAuthMiddleware, (req, res, next) => {
  const tenantId = (req as any).tenantId;
  if (!uploadRateLimiter.check(tenantId)) {
    logger.warn({ tenantId }, '[UPLOAD] Rate limit excedido en POST /api/upload/confirm-mapping');
    return res.status(429).json({ error: 'Demasiadas subidas de archivo. Esperá un minuto e intentá de nuevo.' });
  }
  next();
}, (req, res, next) => {
  upload.single('excelFile')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMb = Math.floor(config.uploadMaxFileSizeBytes / (1024 * 1024));
        return res.status(413).json({ error: `El archivo supera el tamaño máximo permitido (${maxMb}MB).` });
      }
      logger.error({ error: err.message, tenantId: (req as any).tenantId }, '[UPLOAD] Error de multer al procesar el archivo subido');
      return res.status(400).json({ error: 'No se pudo procesar el archivo subido.' });
    }
    next();
  });
}, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  let mappingsBySheet: Record<string, Partial<Record<ExcelMappingField, string | null>>>;
  try {
    mappingsBySheet = JSON.parse(String(req.body?.mappings || ''));
  } catch {
    return res.status(400).json({ error: 'El campo "mappings" debe ser un JSON válido con el mapeo confirmado por hoja.' });
  }

  try {
    const sheetsHeaders = peekExcelHeaders(req.file.buffer);
    const mappingsBySignature = new Map<string, Partial<Record<ExcelMappingField, string | null>>>();

    for (const { sheetName, headers } of sheetsHeaders) {
      const fieldMap = mappingsBySheet[sheetName];
      if (fieldMap) {
        const { headerSignature, fields } = await confirmColumnMapping(tenantId, headers, fieldMap, tenantSupabase);
        mappingsBySignature.set(headerSignature, toColumnMapRecord(fields));
        continue;
      }

      // KAN-84: POST /api/upload solo devuelve al frontend las hojas que necesitaron
      // confirmación — una hoja que ya se resolvió sola (heurística/IA) en esa misma corrida
      // nunca aparece en `data.sheets`, así que el frontend no puede mandar un mapeo explícito
      // para ella acá. En vez de rechazar la request, se vuelve a resolver: como esa hoja ya
      // quedó persistida como confirmada en la corrida anterior, esto pega el camino "stored"
      // (sin heurística ni IA de nuevo). Si por algún motivo ya no resuelve, ahí sí es un error
      // real del cliente (mapeo incompleto).
      const resolution = await resolveColumnMapping(tenantId, headers, tenantSupabase);
      if (resolution.status !== 'ready') {
        return res.status(400).json({ error: `Falta el mapeo confirmado para la hoja "${sheetName}".` });
      }
      mappingsBySignature.set(resolution.headerSignature, toColumnMapRecord(resolution.fields));
    }

    const { properties: catalog, priceParseErrors } = processExcelBufferWithColumnMap(req.file.buffer, mappingsBySignature);
    if (catalog.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    await syncPropertiesToDatabase(catalog, tenantId, tenantSupabase);

    if (priceParseErrors.length > 0) {
      logger.warn(
        { tenantId, priceParseErrors },
        '[UPLOAD] Filas con precio no parseable detectadas al procesar el Excel'
      );
    }

    res.json({ success: true, count: catalog.length, priceParseErrors });
  } catch (error: any) {
    if (error instanceof ExcelMappingServiceError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error al confirmar mapeo de columnas y procesar Excel:', error);
    res.status(500).json({ error: error.message || 'Error interno al procesar el archivo.' });
  }
});

app.get('/api/catalog', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  try {
    const { count, error } = await tenantSupabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (error: any) {
    logger.error({ tenantId, err: error.message }, '[CATALOGO] Error al contar propiedades del tenant');
    res.status(500).json({ error: 'Error interno al obtener el catálogo.' });
  }
});

interface SearchSegmentResult {
  success: boolean;
  raw_text: string;
  search?: { id: string; criteria: any; zone_status: string; zone_names: string[]; expires_at: string };
  matches?: any[];
  error?: string;
  code?: string;
}

// Procesa UN segmento de búsqueda ya extraído del mensaje original (ver segmentSearchRequests) a
// través del pipeline completo: Agente 1 -> Agente 2 (zona) -> insert en active_searches (ya con
// el estado de zona persistido) -> matching cross-tenant -> persistencia de blind_matches ->
// notificaciones bidireccionales. Extraído a función propia para poder correrlo una vez por cada
// sub-búsqueda de un mensaje multi-búsqueda.
async function processSingleSearchSegment(
  tenantId: string,
  tenantSupabase: any,
  segmentText: string
): Promise<SearchSegmentResult> {
  const extractedData = await extractFromTextInput(segmentText);

  if (extractedData.operation === 'desconocido') {
    return { success: false, raw_text: segmentText, error: 'No pudimos clasificar el texto como un pedido de propiedad.' };
  }

  // KAN-22 + estados de zona (2026-08-11): zoneIntent (Agente 2) se resuelve ANTES del insert (no
  // después, como antes de este cambio) para poder persistir zone_status/zone_ids/zone_names/
  // zone_text_original en el mismo insert — elimina la ventana donde una fila de active_searches
  // existía sin haber corrido el Agente 2 todavía. extractZoneIntent nunca lanza (fallback
  // silencioso ante fallo total de IA), así que no necesita try/catch propio.
  const zoneIntent = await extractZoneIntent(segmentText, extractedData.operation);

  const { data: search, error: insertErr } = await tenantSupabase
    .from('active_searches')
    .insert({
      tenant_id: tenantId,
      raw_text: segmentText,
      criteria: extractedData,
      zone_status: zoneIntent.zone_status,
      zone_ids: zoneIntent.zona_ids,
      zone_names: zoneIntent.zona_nombres,
      zone_text_original: zoneIntent.texto_ubicacion_original
    })
    .select('id, criteria, zone_status, zone_names, created_at, expires_at')
    .single();

  if (insertErr) throw insertErr;

  const matches = await findCrossTenantMatches(tenantId, extractedData, zoneIntent);

  const mappedMatches = matches.map(m => ({
    tenant_id: m.tenant_id,
    score: m.score,
    reasons: m.reasons,
    property: mapPropertyToBlindMatchShape(m.property)
  }));

  // KAN-78: persistencia del resultado del matching ciego — se arma un snapshot del propio perfil
  // (buscador) para que el dueño de la propiedad matcheada pueda contactarlo más adelante sin
  // depender de que este mire a tiempo su notificación/email.
  let matchIds: (string | null)[] = mappedMatches.map(() => null);
  let searcherSnapshot: SearcherSnapshot = { full_name: null, phone_number: null, agency_name: null, email: null };
  if (mappedMatches.length > 0) {
    try {
      const { data: ownProfile, error: profileErr } = await tenantSupabase
        .from('profiles')
        .select('full_name, phone_number, agency_name, email')
        .eq('id', tenantId)
        .single();
      if (profileErr) throw profileErr;

      searcherSnapshot = {
        full_name: ownProfile?.full_name ?? null,
        phone_number: ownProfile?.phone_number ?? null,
        agency_name: ownProfile?.agency_name ?? null,
        email: ownProfile?.email ?? null
      };

      const insertRows = buildBlindMatchInsertRows(tenantId, search.id, segmentText, searcherSnapshot, mappedMatches);
      const { data: insertedMatches, error: matchInsertErr } = await tenantSupabase
        .from('blind_matches')
        .insert(insertRows)
        .select('id');

      if (matchInsertErr) throw matchInsertErr;
      matchIds = (insertedMatches || []).map((row: any) => row.id);
    } catch (persistErr: any) {
      // Best-effort: los matches ya se calcularon, no tiene sentido fallar una búsqueda exitosa
      // porque la persistencia falló — solo se pierde el historial/aviso al dueño de esta tanda.
      logger.error({ error: persistErr.message || persistErr, tenantId, searchId: search.id }, '[BUSQUEDA] Error al persistir los matches en blind_matches (no afecta la búsqueda ya calculada)');
    }
  }

  const mappedMatchesWithIds = mappedMatches.map((m, i) => ({ ...m, id: matchIds[i] ?? null }));

  // KAN-44: evento "match encontrado" en el único punto donde hoy se genera en vivo (una búsqueda
  // nueva). Fire-and-forget: no bloquea ni puede hacer fallar la respuesta ya devuelta al caller.
  // KAN-48: email como respaldo permanente — notifyMatchFound() solo lo dispara si el tenant no
  // tiene ninguna suscripción push activa, para no duplicar el aviso.
  if (mappedMatches.length > 0) {
    notifyMatchFound({
      hasActivePush: () => hasActivePushSubscriptions(tenantId),
      sendPush: () => sendWebPushToTenant(tenantId, buildMatchFoundPushPayload(search.id)),
      sendEmailFallback: () => sendBlindMatchEmailFallback(tenantId, segmentText, mappedMatches)
    }).catch((notifyErr: any) => {
      logger.error({ error: notifyErr.message || notifyErr, tenantId, searchId: search.id }, '[BUSQUEDA] Error al notificar el match encontrado (no afecta la búsqueda ya confirmada)');
    });

    // KAN-78: dirección recíproca — avisar también al dueño de cada propiedad matcheada.
    const bySearcherOwner = groupMatchesByMatchedTenant(mappedMatches);

    // KAN-88: evento en vivo del contador de matches.
    broadcastMatchCountChanged([tenantId, ...Object.keys(bySearcherOwner)]);

    for (const [ownerTenantId, ownerMatches] of Object.entries(bySearcherOwner)) {
      notifyMatchFound({
        hasActivePush: () => hasActivePushSubscriptions(ownerTenantId),
        sendPush: () => sendWebPushToTenant(ownerTenantId, buildIncomingMatchPushPayload(search.id)),
        sendEmailFallback: () => sendIncomingMatchEmailFallback(ownerTenantId, searcherSnapshot, segmentText, ownerMatches)
      }).catch((notifyErr: any) => {
        logger.error({ error: notifyErr.message || notifyErr, tenantId: ownerTenantId, searchId: search.id }, '[BUSQUEDA] Error al notificar al dueño de una propiedad matcheada (no afecta la búsqueda ya confirmada)');
      });
    }
  }

  return {
    success: true,
    raw_text: segmentText,
    search: { id: search.id, criteria: search.criteria, zone_status: search.zone_status, zone_names: search.zone_names, expires_at: search.expires_at },
    matches: mappedMatchesWithIds
  };
}

// KAN-37: motor de matching bidireccional entre tenants, dirección búsqueda→cartera. Un tenant
// describe lo que busca en texto libre y recibe matches de la cartera de OTROS tenants (excluye
// la propia). Un mismo mensaje puede describir 2+ pedidos independientes — se segmenta primero
// (Agente 0, ver ai.ts#segmentSearchRequests) y cada segmento se procesa por separado, generando
// su propia fila de active_searches y su propio set de matches/notificaciones.
app.post('/api/search', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  const { text } = req.body;

  // KAN-71: rate limit por tenant — este endpoint dispara llamadas pagas a Gemini/OpenAI por
  // request (extractFromTextInput, y ahora también segmentSearchRequests), así que abuso acá
  // tiene costo real, no solo carga de CPU.
  if (!searchRateLimiter.check(tenantId)) {
    logger.warn({ tenantId }, '[BUSQUEDA] Rate limit excedido en POST /api/search');
    return res.status(429).json({ error: 'Demasiadas búsquedas. Esperá un minuto e intentá de nuevo.' });
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'El texto de búsqueda es requerido.' });
  }

  const validationError = validateFreeSearchText(text);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  if (!config.freeTextExtractionEnabled) {
    return res.status(501).json({ error: 'La búsqueda de texto libre (matching ciego) todavía no está habilitada.' });
  }

  let segments: string[];
  try {
    segments = await segmentSearchRequests(text); // Agente 0 — fail-soft, nunca lanza
  } catch (error: any) {
    // Defensivo: aunque segmentSearchRequests no debería lanzar, un fallo acá no debe bloquear
    // el flujo — degradar al mensaje completo como única búsqueda.
    logger.error({ error: error.message || error, tenantId }, '[BUSQUEDA] Error inesperado en segmentación; se procesa como búsqueda única.');
    segments = [text];
  }

  const results: SearchSegmentResult[] = [];
  let anyAITimeout = false;

  for (const segmentText of segments) {
    try {
      const result = await processSingleSearchSegment(tenantId, tenantSupabase, segmentText);
      results.push(result);
    } catch (error: any) {
      if (error instanceof AITimeoutError) {
        anyAITimeout = true;
        results.push({ success: false, raw_text: segmentText, error: error.message, code: 'AI_TIMEOUT' });
        continue; // seguir con los demás segmentos, no abortar todo el lote por un timeout puntual
      }
      logger.error({ error: error.message || error, tenantId, segmentText }, '[BUSQUEDA] Error al procesar un segmento de búsqueda.');
      results.push({ success: false, raw_text: segmentText, error: error.message || 'Error interno al procesar este segmento.' });
    }
  }

  const allFailed = results.every(r => !r.success);
  const httpStatus = allFailed ? (anyAITimeout ? 504 : 500) : 200;

  res.status(httpStatus).json({
    success: !allFailed,
    segmented: segments.length > 1,
    searches: results
  });
});

// KAN-39: listado de búsquedas activas propias con conteo de matches cross-tenant. El conteo se
// recalcula en vivo reusando findCrossTenantMatches (mismo motor que POST /api/search) porque el
// matching ciego, por decisión explícita de KAN-37, no persiste los matches cruzados (no hay
// tabla que relacione active_searches con propiedades de otro tenant) — no hay un contador
// guardado del que leer, y recalcularlo es lo que garantiza que quede "consistente con la base".
// Incluye 'expired' además de 'active' (antes solo traía 'active') para que el dashboard pueda
// ofrecer "Reactivar" sobre búsquedas vencidas — 'matched'/'cancelled' (archivadas) quedan afuera.
app.get('/api/searches', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;

  try {
    const { data: searches, error } = await tenantSupabase
      .from('active_searches')
      .select('id, raw_text, criteria, status, zone_status, zone_ids, zone_names, zone_text_original, created_at, expires_at')
      .eq('tenant_id', tenantId)
      .in('status', ['active', 'expired'])
      .order('created_at', { ascending: false });

    if (error) throw error;

    const results = await Promise.all((searches || []).map(async (search: any) => {
      let matchesCount = 0;
      try {
        // Reconstruye el zoneIntent persistido para que el recálculo en vivo respete el estado de
        // zona real de la búsqueda (antes de este cambio se ignoraba por completo acá).
        const zoneIntent: ZoneIntentRequest = {
          zone_status: search.zone_status,
          zona_ids: search.zone_ids || [],
          zona_nombres: search.zone_names || [],
          texto_ubicacion_original: search.zone_text_original || '',
          dormitorios_min: null,
          caracteristicas_claves: [],
          operacion: 'DESCONOCIDO'
        };
        const matches = await findCrossTenantMatches(tenantId, search.criteria, zoneIntent);
        matchesCount = matches.length;
      } catch (matchError: any) {
        logger.error({ error: matchError.message || matchError, tenantId, searchId: search.id }, '[BUSQUEDAS] Error al calcular el conteo de matches de una búsqueda activa');
      }

      return {
        id: search.id,
        raw_text: search.raw_text,
        criteria: search.criteria,
        status: search.status,
        zone_status: search.zone_status,
        zone_names: search.zone_names || [],
        created_at: search.created_at,
        expires_at: search.expires_at,
        days_remaining: calculateDaysRemaining(search.expires_at),
        matches_count: matchesCount
      };
    }));

    res.json({ searches: results });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[BUSQUEDAS] Error al listar búsquedas activas');
    res.status(500).json({ error: error.message || 'Error interno al listar las búsquedas.' });
  }
});

// KAN-40: baja de una búsqueda activa antes de que venza. Necesita distinguir 403 (existe pero es
// de otro tenant) de 404 (no existe para nadie) - el cliente tenant-scoped con RLS de KAN-63 nunca
// podría hacer esa distinción por sí solo (una fila ajena simplemente no aparece, sin importar si
// existe o no), así que el chequeo de existencia/dueño se hace con el cliente service-role antes
// de mutar con el cliente tenant-scoped (mismo patrón de "chequeo privilegiado + mutación
// tenant-scoped" que ya usan otros endpoints de este archivo).
// Cambio de semántica (dashboard visual): "eliminar" ya no es un hard delete — pasa a
// status='cancelled' (archivada). El registro se conserva para auditoría/historial y deja de
// aparecer en GET /api/searches (que solo trae 'active'/'expired').
app.delete('/api/searches/:id', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'El ID de la búsqueda está mal formado.' });
  }

  try {
    const { supabase } = require('./services/supabase');

    const { data: search, error: fetchError } = await supabase
      .from('active_searches')
      .select('id, tenant_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!search) {
      return res.status(404).json({ error: 'La búsqueda no existe.' });
    }
    if (search.tenant_id !== tenantId) {
      return res.status(403).json({ error: 'No tenés permiso para archivar esta búsqueda.' });
    }

    const { error: archiveError } = await tenantSupabase
      .from('active_searches')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (archiveError) throw archiveError;

    logger.info({ tenantId, searchId: id }, '[AUDITORIA] Búsqueda archivada por su propietario');

    sendWebPushToTenant(tenantId, {
      title: 'Búsqueda archivada',
      body: 'Diste de baja una búsqueda antes de que venciera.',
      tag: `search-deleted-${id}`,
      data: { url: '/' }
    }).catch((pushErr: any) => {
      logger.error({ error: pushErr.message || pushErr, tenantId, searchId: id }, '[BUSQUEDAS] Error al enviar la notificación de baja (no afecta el archivado ya confirmado)');
    });

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId, searchId: id }, '[BUSQUEDAS] Error al archivar la búsqueda');
    res.status(500).json({ error: error.message || 'Error interno al archivar la búsqueda.' });
  }
});

// Reactivación de una búsqueda vencida (dashboard visual): solo válida desde status='expired',
// vuelve a 'active' con 7 días nuevos de vencimiento a partir de ahora (mismo plazo que el trigger
// de creación, `set_active_searches_expires_at`, que no aplica en UPDATE). Mismo patrón de
// "chequeo privilegiado + mutación tenant-scoped" que DELETE de arriba.
app.post('/api/searches/:id/reactivate', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'El ID de la búsqueda está mal formado.' });
  }

  try {
    const { supabase } = require('./services/supabase');

    const { data: search, error: fetchError } = await supabase
      .from('active_searches')
      .select('id, tenant_id, status')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!search) {
      return res.status(404).json({ error: 'La búsqueda no existe.' });
    }
    if (search.tenant_id !== tenantId) {
      return res.status(403).json({ error: 'No tenés permiso para reactivar esta búsqueda.' });
    }
    if (search.status !== 'expired') {
      return res.status(400).json({ error: 'Solo se pueden reactivar búsquedas vencidas.' });
    }

    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: updated, error: updateError } = await tenantSupabase
      .from('active_searches')
      .update({ status: 'active', expires_at: newExpiresAt })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id, expires_at')
      .single();

    if (updateError) throw updateError;

    logger.info({ tenantId, searchId: id }, '[AUDITORIA] Búsqueda reactivada por su propietario');

    res.json({ success: true, expires_at: updated.expires_at });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId, searchId: id }, '[BUSQUEDAS] Error al reactivar la búsqueda');
    res.status(500).json({ error: error.message || 'Error interno al reactivar la búsqueda.' });
  }
});

// KAN-78: reescrito contra blind_matches (reemplaza a match_queue, eliminada). Sin fallback a
// coordinator — ese fallback era un Map en memoria permanentemente vacío (nada lo poblaba desde
// el retiro de WhatsApp); ante un error real de DB ahora se responde 500 en vez de degradar en
// silencio a una lista vacía.
app.get('/api/matches', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const supabase = (req as any).supabaseClient;
  try {
    const { data: dbMatches, error } = await supabase
      .from('blind_matches')
      .select('id, created_at, raw_search_text, property_snapshot, score, reasons, user_review_status, feedback_reason')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const mappedMatches = (dbMatches || []).map(mapBlindMatchRowToDashboardShape);

    res.json({ matches: mappedMatches });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[MATCHES] Error al recuperar matches de blind_matches');
    res.status(500).json({ error: error.message || 'Error interno al recuperar matches.' });
  }
});

// KAN-78: nuevo — dirección recíproca de GET /api/matches. Le permite al dueño de una propiedad
// matcheada ver quién la buscó (nombre/teléfono/inmobiliaria, congelados en searcher_snapshot al
// momento del match), habilitado por la policy RLS de solo lectura "blind_matches_matched_tenant_read"
// (matched_tenant_id = auth.uid()). Solo lectura: la curación (user_review_status/feedback_reason)
// sigue siendo exclusiva del buscador vía POST /api/matches/:id/feedback.
app.get('/api/matches/incoming', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const supabase = (req as any).supabaseClient;
  try {
    const { data: dbMatches, error } = await supabase
      .from('blind_matches')
      .select('id, created_at, raw_search_text, property_snapshot, searcher_snapshot, score, reasons')
      .eq('matched_tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const mappedMatches = (dbMatches || []).map(mapIncomingMatchRowToDashboardShape);

    res.json({ matches: mappedMatches });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[MATCHES] Error al recuperar matches entrantes de blind_matches');
    res.status(500).json({ error: error.message || 'Error interno al recuperar matches entrantes.' });
  }
});

// KAN-79: endpoint interno SIN sesión de usuario — lo llama el trigger de Postgres
// (property_uploaded_trigger, AFTER INSERT ON properties) vía pg_net cuando entra una propiedad
// nueva, para la dirección cartera→búsqueda del matching bidireccional (complementaria a
// POST /api/search, que ya cubre búsqueda→cartera). No usa tenantAuthMiddleware porque no hay JWT
// de tenant en esta llamada — se protege con un secreto compartido en vez de una sesión.
app.post('/internal/property-match-check', async (req, res) => {
  const providedSecret = req.header('x-internal-secret');
  if (!isValidInternalWebhookSecret(providedSecret, config.internalWebhookSecret)) {
    logger.warn('[PROPERTY MATCH WEBHOOK] Intento de acceso sin secreto válido a /internal/property-match-check.');
    return res.status(401).json({ error: 'No autorizado.' });
  }

  const { property_id } = req.body;
  if (!isValidUUID(property_id)) {
    return res.status(400).json({ error: 'property_id inválido.' });
  }

  try {
    const result = await processPropertyUploaded(property_id);
    res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    logger.error({ error: error.message || error, propertyId: property_id }, '[PROPERTY MATCH WEBHOOK] Error al procesar el matching cartera→búsqueda.');
    res.status(500).json({ error: 'Error interno al procesar el matching.' });
  }
});

app.post('/api/matches/:id/feedback', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  const { status, reason } = req.body;
  const supabase = (req as any).supabaseClient;

  if (!status || !['ACCEPTED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'El estado debe ser ACCEPTED o REJECTED' });
  }

  try {
    const { data, error } = await supabase
      .from('blind_matches')
      .update({
        user_review_status: status,
        feedback_reason: status === 'REJECTED' ? (reason || 'No especificado') : null
      })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id');

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Match no encontrado.' });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error al actualizar el feedback de match:', error);
    res.status(500).json({ error: error.message || 'Error interno al guardar feedback.' });
  }
});

app.get('/api/notifications/vapid-public-key', tenantAuthMiddleware, (req, res) => {
  const { config } = require('./config/env');
  res.json({ publicKey: config.vapidPublicKey });
});

app.post('/api/notifications/subscribe', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { subscription } = req.body;
  const supabase = (req as any).supabaseClient;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }

  try {
    // Buscar si ya existe la suscripción para este tenant
    const { data: existing, error: selectError } = await supabase
      .from('web_push_subscriptions')
      .select('id')
      .eq('tenant_id', tenantId)
      .filter('subscription->>endpoint', 'eq', subscription.endpoint)
      .maybeSingle();

    if (selectError) throw selectError;

    if (!existing) {
      const { error: insertError } = await supabase
        .from('web_push_subscriptions')
        .insert({
          tenant_id: tenantId,
          subscription
        });
      if (insertError) throw insertError;
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error al registrar suscripción web push:', error);
    res.status(500).json({ error: error.message || 'Error interno al suscribir.' });
  }
});

// KAN-124: manejador de errores global — DEBE quedar como el último app.use(), después de
// mountAdminRouter y de todas las rutas de tenant/API de arriba, para que también atrape errores
// que suben desde adminRouter (AC4) y no solo del pipeline de tenants. Ver src/utils/errorHandler.ts.
app.use(globalErrorHandler);

// ==========================================
// FUNCIÓN PRINCIPAL DE ARRANQUE (MAIN)
// ==========================================

async function main() {
  console.log('Iniciando Brokaza MVP Multi-Tenant con Dashboard...');

  // Iniciar servicio de cotización de Dólar Blue (dinámico y horaria)
  startDolarService();

  // Iniciar servicio de vencimiento de búsquedas sin match a los 7 días (KAN-41)
  startSearchExpirationService();

  // KAN-78: el notificador consolidado por email (startEmailNotificationService) se eliminó junto
  // con match_queue — corría cada NOTIFICATION_INTERVAL_MINUTES sin hacer nada desde el pivot a
  // matching 100% web (nada escribía filas nuevas en match_queue). El único canal de notificación
  // activo hoy es el del matching ciego (notifyMatchFound, disparado desde POST /api/search).

  // Levantar servidor Express + WebSocket (KAN-88) sobre el mismo puerto/servidor HTTP.
  const server = http.createServer(app);
  initRealtimeHub(server);

  server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`DASHBOARD DISPONIBLE EN: http://localhost:${PORT}`);
    console.log(`=========================================\n`);
  });
}

// Iniciar aplicación
main().catch((error) => {
  console.error('Fallo crítico al iniciar la aplicación:', error);
});
