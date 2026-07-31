import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

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
import { coordinator } from './services/coordinator';
import { extractFromTextInput, extractZoneIntent, AITimeoutError } from './services/ai';
import { findCrossTenantMatches } from './services/blindMatching';
import { validateFreeSearchText } from './utils/searchValidation';
import { calculateDaysRemaining } from './utils/activeSearches';
import { validateProfileInput } from './utils/profileValidation';
import { isValidUUID } from './utils/idValidation';
import { isValidInternalWebhookSecret } from './utils/internalWebhookAuth';
import { sendWebPushToTenant, buildMatchFoundPushPayload, buildIncomingMatchPushPayload, hasActivePushSubscriptions } from './services/webPush';
import { sendBlindMatchEmailFallback, sendIncomingMatchEmailFallback } from './services/notifier-email';
import { notifyMatchFound } from './services/notifications';
import { processPropertyUploaded } from './services/propertyMatchWebhook';
import { startDolarService } from './services/dolar';
import { startSearchExpirationService } from './services/searchExpiration';
import { config } from './config/env';
import { logger } from './services/logger';
import { withTimeout } from './utils/withTimeout';
import { createRateLimiter } from './utils/rateLimit';
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
        'script-src': ["'self'", (_req, res) => `'nonce-${(res as express.Response).locals.cspNonce}'`]
      }
    }
  })
);
app.use(express.json());
app.use(cookieParser());

// Servir archivos estáticos del dashboard (soportando dev y prod)
const dashboardPath = fs.existsSync(path.join(__dirname, 'dashboard'))
  ? path.join(__dirname, 'dashboard')
  : path.join(process.cwd(), 'src', 'dashboard');
const dashboardIndexHtml = fs.readFileSync(path.join(dashboardPath, 'index.html'), 'utf-8');

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

/**
 * Utilidad para extraer de forma robusta la IP del cliente (considerando proxies como Railway)
 */
function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  let ip = 'unknown';
  if (forwarded) {
    const list = typeof forwarded === 'string' ? forwarded.split(',') : forwarded;
    ip = list[0].trim();
  } else {
    ip = req.socket.remoteAddress || 'unknown';
  }

  // Normalizar localhost (tanto IPv4, IPv6 y IPv4-mapped IPv6)
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    return '127.0.0.1';
  }
  return ip;
}

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
  const token = req.cookies?.housematch_session;
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
      res.clearCookie('housematch_session');
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

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN (PÚBLICOS)
// ==========================================

app.get('/api/auth/session', async (req, res) => {
  const token = req.cookies?.housematch_session;
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
      res.clearCookie('housematch_session');
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
    // Crear perfil en primera sesión si no existe (full_name/email son NOT NULL en la tabla)
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: user.id,
      email: user.email,
      full_name: user.email?.split('@')[0] || user.id
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (profileError) {
      logger.error({ tenantId: user.id, err: profileError.message }, '[AUTH] Error al crear/actualizar perfil');
    }
    res.cookie('housematch_session', access_token, {
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
  const token = req.cookies?.housematch_session;
  if (token) clearCachedSession(token);
  res.clearCookie('housematch_session');
  res.json({ success: true });
});

// ==========================================
// ENDPOINTS DE PERFIL DE TENANT (KAN-64)
// ==========================================
// Con el retiro de WhatsApp/Baileys como canal de entrada, el agente inmobiliario completa su
// perfil (telefono, inmobiliaria, ciudad, pais) despues del magic link, no via WhatsApp OTP.

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
  const { phone_number, agency_name, city, country } = req.body;

  const validationError = validateProfileInput({ phone_number, agency_name, city, country });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const { data: profile, error } = await tenantSupabase
      .from('profiles')
      .update({
        phone_number: (phone_number as string).trim(),
        agency_name: (agency_name as string).trim(),
        city: (city as string).trim(),
        country: (country as string).trim(),
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
    coordinator.setCatalog(tenantId, catalog);
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

    coordinator.setCatalog(tenantId, catalog);
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

app.get('/api/catalog', tenantAuthMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const catalog = coordinator.getCatalog(tenantId);
  res.json({ count: catalog.length });
});

// KAN-37: motor de matching bidireccional entre tenants, dirección búsqueda→cartera. Un tenant
// describe lo que busca en texto libre y recibe matches de la cartera de OTROS tenants (excluye
// la propia). La dirección cartera→búsqueda (auto-revisar active_searches de otros tenants al
// sincronizar una propiedad nueva) queda fuera de alcance de este ticket.
app.post('/api/search', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  const { text } = req.body;

  // KAN-71: rate limit por tenant — este endpoint dispara llamadas pagas a Gemini/OpenAI por
  // request (extractFromTextInput), así que abuso acá tiene costo real, no solo carga de CPU.
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

  try {
    const extractedData = await extractFromTextInput(text);

    if (extractedData.operation === 'desconocido') {
      return res.status(400).json({ error: 'No pudimos clasificar el texto como un pedido de propiedad.' });
    }

    const { data: search, error: insertErr } = await tenantSupabase
      .from('active_searches')
      .insert({
        tenant_id: tenantId,
        raw_text: text,
        criteria: extractedData
      })
      .select('id, criteria, created_at, expires_at')
      .single();

    if (insertErr) throw insertErr;

    // KAN-22: zoneIntent (Agente 2) resuelve zona_id vía PostGIS/alias contra `neighborhoods`
    // (ver ai.ts#extractZoneIntent) — antes de este ticket nunca se calculaba ni se pasaba acá,
    // así que ZoneMatchingStrategy solo podía usar el branch de `request.zones` (Agente 1,
    // comparación textual contra sheet_name). extractZoneIntent nunca lanza (ídem
    // extractFromTextInput con fallback silencioso), así que no necesita try/catch propio.
    const zoneIntent = await extractZoneIntent(text, extractedData.operation);

    const matches = await findCrossTenantMatches(tenantId, extractedData, zoneIntent);

    const mappedMatches = matches.map(m => ({
      tenant_id: m.tenant_id,
      score: m.score,
      reasons: m.reasons,
      property: mapPropertyToBlindMatchShape(m.property)
    }));

    // KAN-78: persistencia del resultado del matching ciego — hasta este ticket, findCrossTenantMatches
    // no guardaba nada, los matches se devolvían una única vez en esta respuesta HTTP. Se arma un
    // snapshot del propio perfil (buscador) para que el dueño de la propiedad matcheada pueda
    // contactarlo más adelante sin depender de que este mire a tiempo su notificación/email.
    let matchIds: (string | null)[] = mappedMatches.map(() => null);
    let searcherSnapshot: SearcherSnapshot = { full_name: null, phone_number: null, agency_name: null };
    if (mappedMatches.length > 0) {
      try {
        const { data: ownProfile, error: profileErr } = await tenantSupabase
          .from('profiles')
          .select('full_name, phone_number, agency_name')
          .eq('id', tenantId)
          .single();
        if (profileErr) throw profileErr;

        searcherSnapshot = {
          full_name: ownProfile?.full_name ?? null,
          phone_number: ownProfile?.phone_number ?? null,
          agency_name: ownProfile?.agency_name ?? null
        };

        const insertRows = buildBlindMatchInsertRows(tenantId, search.id, text, searcherSnapshot, mappedMatches);
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

    res.json({
      success: true,
      search: { id: search.id, criteria: search.criteria, expires_at: search.expires_at },
      matches: mappedMatchesWithIds
    });

    // KAN-44: evento "match encontrado" en el único punto donde hoy se genera en vivo (una
    // búsqueda nueva). GET /api/searches recalcula el mismo conteo cada 10s vía polling del
    // dashboard (KAN-42) — engancharlo ahí spamearía un push por poll mientras la búsqueda siga
    // activa. Fire-and-forget: no bloquea ni puede hacer fallar la respuesta ya enviada.
    // Payload sin datos de la propiedad/contacto (esos ya viajaron en la respuesta HTTP, detrás
    // de auth) — el push es solo un aviso genérico para evitar filtrar info de otro tenant por un
    // canal sin control de acceso propio.
    // KAN-48: email como respaldo permanente, no como reemplazo — notifyMatchFound() solo lo
    // dispara si el tenant no tiene ninguna suscripción push activa, para no duplicar el aviso.
    if (mappedMatches.length > 0) {
      notifyMatchFound({
        hasActivePush: () => hasActivePushSubscriptions(tenantId),
        sendPush: () => sendWebPushToTenant(tenantId, buildMatchFoundPushPayload(search.id)),
        sendEmailFallback: () => sendBlindMatchEmailFallback(tenantId, text, mappedMatches)
      }).catch((notifyErr: any) => {
        logger.error({ error: notifyErr.message || notifyErr, tenantId, searchId: search.id }, '[BUSQUEDA] Error al notificar el match encontrado (no afecta la búsqueda ya confirmada)');
      });

      // KAN-78: dirección recíproca — avisar también al dueño de cada propiedad matcheada, para
      // que el match no dependa 100% de que el buscador revise su propia notificación/email a
      // tiempo. Se agrupa por dueño para no spamear a un tenant con varias propiedades matcheadas
      // en la misma búsqueda.
      const bySearcherOwner = groupMatchesByMatchedTenant(mappedMatches);
      for (const [ownerTenantId, ownerMatches] of Object.entries(bySearcherOwner)) {
        notifyMatchFound({
          hasActivePush: () => hasActivePushSubscriptions(ownerTenantId),
          sendPush: () => sendWebPushToTenant(ownerTenantId, buildIncomingMatchPushPayload(search.id)),
          sendEmailFallback: () => sendIncomingMatchEmailFallback(ownerTenantId, searcherSnapshot, text, ownerMatches)
        }).catch((notifyErr: any) => {
          logger.error({ error: notifyErr.message || notifyErr, tenantId: ownerTenantId, searchId: search.id }, '[BUSQUEDA] Error al notificar al dueño de una propiedad matcheada (no afecta la búsqueda ya confirmada)');
        });
      }
    }
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[BUSQUEDA] Error al procesar búsqueda de matching ciego');
    // KAN-70: distinguible del 500 genérico para que el frontend pueda mostrar un mensaje
    // específico ("el servicio de IA tardó demasiado") en vez del error interno genérico.
    if (error instanceof AITimeoutError) {
      return res.status(504).json({ error: error.message, code: 'AI_TIMEOUT' });
    }
    res.status(500).json({ error: error.message || 'Error interno al procesar la búsqueda.' });
  }
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
      .select('id, raw_text, criteria, status, created_at, expires_at')
      .eq('tenant_id', tenantId)
      .in('status', ['active', 'expired'])
      .order('created_at', { ascending: false });

    if (error) throw error;

    const results = await Promise.all((searches || []).map(async (search: any) => {
      let matchesCount = 0;
      try {
        const matches = await findCrossTenantMatches(tenantId, search.criteria);
        matchesCount = matches.length;
      } catch (matchError: any) {
        logger.error({ error: matchError.message || matchError, tenantId, searchId: search.id }, '[BUSQUEDAS] Error al calcular el conteo de matches de una búsqueda activa');
      }

      return {
        id: search.id,
        raw_text: search.raw_text,
        criteria: search.criteria,
        status: search.status,
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

// ==========================================
// FUNCIÓN PRINCIPAL DE ARRANQUE (MAIN)
// ==========================================

async function main() {
  console.log('Iniciando HouseMatch MVP Multi-Tenant con Dashboard...');

  const { supabase } = require('./services/supabase');

  // KAN-64: la lista de tenants para precargar el catalogo en memoria salia antes de
  // whatsapp_sessions (una fila por tenant con sesion de Baileys alguna vez iniciada) - esa
  // tabla se elimino junto con el retiro de WhatsApp como canal de entrada. La fuente correcta
  // ahora es profiles (todo agente inmobiliario registrado), sin depender de si alguna vez
  // conecto WhatsApp.
  let tenantIds: string[] = [];
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id');

    if (error) throw error;
    tenantIds = (data || []).map((row: any) => row.id);
  } catch (e) {
    console.warn('[MAIN - SUPABASE] No se pudo recuperar la lista de tenants para el arranque inicial:', e);
  }

  // Precargar el catalogo en memoria de cada tenant registrado
  for (const tenantId of tenantIds) {
    if (tenantId === '00000000-0000-0000-0000-000000000000') {
      continue;
    }

    let propertyCatalog: Property[] = [];
    try {
      const { data: dbProperties, error: propErr } = await supabase
        .from('properties')
        .select('*')
        .eq('tenant_id', tenantId);

      if (propErr) throw propErr;

      if (dbProperties && dbProperties.length > 0) {
        console.log(`[MAIN - SUPABASE] Catálogo cargado desde Supabase para tenant ${tenantId} (${dbProperties.length} propiedades).`);
        propertyCatalog = dbProperties.map((p: any) => ({
          address: p.address,
          floor: p.floor || undefined,
          unit: p.unit || undefined,
          block: p.block || undefined,
          lot: p.lot || undefined,
          price: p.price,
          currency: p.currency,
          maintenance_fees: p.maintenance_fees,
          bedrooms: p.bedrooms,
          features: p.features || undefined,
          contact_info: p.contact_info || undefined,
          property_type: p.property_type,
          operation: p.operation,
          zone_display_name: p.sheet_name,
          sheet_name: p.sheet_name,
          latitude: p.latitude,
          longitude: p.longitude
        }));
      }
    } catch (e) {
      console.warn(`[ARRANQUE] Error al cargar catálogo de Supabase del tenant ${tenantId}:`, e);
    }

    coordinator.setCatalog(tenantId, propertyCatalog);
  }

  // Iniciar servicio de cotización de Dólar Blue (dinámico y horaria)
  startDolarService();

  // Iniciar servicio de vencimiento de búsquedas sin match a los 7 días (KAN-41)
  startSearchExpirationService();

  // KAN-78: el notificador consolidado por email (startEmailNotificationService) se eliminó junto
  // con match_queue — corría cada NOTIFICATION_INTERVAL_MINUTES sin hacer nada desde el pivot a
  // matching 100% web (nada escribía filas nuevas en match_queue). El único canal de notificación
  // activo hoy es el del matching ciego (notifyMatchFound, disparado desde POST /api/search).

  // Levantar servidor Express
  app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`DASHBOARD DISPONIBLE EN: http://localhost:${PORT}`);
    console.log(`=========================================\n`);
  });
}

// Iniciar aplicación
main().catch((error) => {
  console.error('Fallo crítico al iniciar la aplicación:', error);
});
