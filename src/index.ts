import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import {
  initTenantSession,
  loadSettings,
  saveSettings,
  getActiveGroups,
  sessionStatuses,
  logoutTenantSession
} from './services/whatsapp';
import { Property, processExcelBuffer, syncPropertiesToDatabase } from './services/excel';
import { coordinator } from './services/coordinator';
import { messageQueue } from './utils/queue';
import { startNotificationService } from './services/notifier';
import { startEmailNotificationService } from './services/notifier-email';
import { startDolarService } from './services/dolar';
import { startSessionCleanupService } from './services/sessionCleanup';
import { config } from './config/env';
import { logger } from './services/logger';

// Express Setup
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

process.on('unhandledRejection', (reason, promise) => {
  console.error('[PROCESO] Promesa no capturada (Unhandled Rejection):', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[PROCESO] Error no controlado (Uncaught Exception):', error);
});

app.use(helmet());
app.use(express.json());
app.use(cookieParser());

// Servir archivos estáticos del dashboard (soportando dev y prod)
const dashboardPath = fs.existsSync(path.join(__dirname, 'dashboard'))
  ? path.join(__dirname, 'dashboard')
  : path.join(process.cwd(), 'src', 'dashboard');
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

/**
 * Ejecuta una promesa con un tiempo límite. Evita que un request quede colgado
 * indefinidamente (spinner infinito en el cliente) ante fallos de red/DNS hacia Supabase.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout de ${ms}ms esperando: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

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
  const { supabase } = require('./services/supabase');
  const token = req.cookies?.housematch_session;
  if (!token) {
    return res.status(401).json({ error: 'No autenticado.' });
  }

  const cached = getCachedSession(token);
  if (cached) {
    (req as any).tenantId = cached.tenantId;
    (req as any).supabaseClient = supabase;
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
    (req as any).supabaseClient = supabase;
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
// ENDPOINTS DE API PROTEGIDOS POR IP (TENANT)
// ==========================================

app.get('/api/status', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { initTenantSession } = require('./services/whatsapp');

  // Comprobar el estado de sesión de WhatsApp
  const { activeSessions, sessionStatuses } = require('./services/whatsapp');
  let tenantStatus = sessionStatuses.get(tenantId);

  // Auto-sanado: Si el tenant no está en activeSessions, volver a iniciarlo
  if (!activeSessions.has(tenantId)) {
    console.log(`[STATUS] Inicializando sesión de WhatsApp (provisional o caída) para tenant ${tenantId}...`);
    initTenantSession(tenantId, {
      onMessage: async (message: any, senderName: any, groupName: any, senderPhone: any, tId: any) => {
        messageQueue.enqueue(async () => {
          await coordinator.handleIncomingMessage(message.body, senderName, groupName, senderPhone, message.id, tId);
        }, tId);
      }
    }).catch((err: any) => {
      console.error(`[STATUS] Fallo de inicio automático de WhatsApp para tenant ${tenantId}:`, err);
    });

    tenantStatus = { status: 'INITIALIZING' };
  }

  res.json(tenantStatus || { status: 'DISCONNECTED' });
});


app.get('/api/groups', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  try {
    const groups = await getActiveGroups(tenantId);
    const settings = loadSettings(tenantId);
    res.json({
      groups,
      selected: settings.selectedGroups
    });
  } catch (error) {
    res.status(500).json({ error: 'No se pudieron recuperar los grupos.' });
  }
});

app.post('/api/groups', tenantAuthMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const { selectedGroups } = req.body;
  if (!Array.isArray(selectedGroups)) {
    return res.status(400).json({ error: 'selectedGroups debe ser un array' });
  }
  saveSettings(tenantId, { selectedGroups });
  res.json({ success: true });
});

app.post('/api/upload', tenantAuthMiddleware, upload.single('excelFile'), async (req, res) => {
  const tenantId = (req as any).tenantId;
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  try {
    const catalog = processExcelBuffer(req.file.buffer);
    if (catalog.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    // Aislamiento por tenant
    coordinator.setCatalog(tenantId, catalog);
    await syncPropertiesToDatabase(catalog, tenantId);

    res.json({ success: true, count: catalog.length });
  } catch (error: any) {
    console.error('Error al procesar subida de Excel:', error);
    res.status(500).json({ error: error.message || 'Error interno al procesar el archivo.' });
  }
});

app.get('/api/catalog', tenantAuthMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const catalog = coordinator.getCatalog(tenantId);
  res.json({ count: catalog.length });
});

app.get('/api/matches', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const supabase = (req as any).supabaseClient;
  try {
    const { data: dbMatches, error } = await supabase
      .from('match_queue')
      .select(`
        *,
        property:properties(*)
      `)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const mappedMatches = dbMatches.map((m: any) => ({
      id: m.id,
      fecha: new Date(m.created_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' }),
      originalText: m.raw_message_text,
      contactSender: m.whatsapp_sender_name,
      groupName: m.whatsapp_group_name,
      property: {
        domicilio: m.property?.address || '',
        pisoLote: [m.property?.floor, m.property?.unit, m.property?.block, m.property?.lot].filter(Boolean).join(' '),
        precio: m.property?.price || 0,
        moneda: m.property?.currency || 'ARS',
        expensas: m.property?.maintenance_fees || 0,
        dormitorios: m.property?.bedrooms || 0,
        caracteristicas: m.property?.features || '',
        contacto: m.property?.contact_info || '',
        zona: m.property?.sheet_name || '',
        operacion: m.property?.operation || '',
        tipo_propiedad: m.property?.property_type || '',
        sheetName: m.property?.sheet_name || ''
      },
      matchDetails: m.match_details || '',
      userReviewStatus: m.user_review_status || 'PENDING',
      feedbackReason: m.feedback_reason || null
    }));

    res.json({ matches: mappedMatches });
  } catch (error: any) {
    console.error('Error al recuperar matches de la base de datos:', error);
    res.json({ matches: coordinator.getRecentMatches(tenantId) });
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
      .from('match_queue')
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

// Pixel 1x1 transparente para trackear apertura de emails de notificación (sin auth: lo pide el cliente de mail)
const TRACKING_PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

app.get('/api/notifications/email/pixel/:matchId.gif', async (req, res) => {
  const { matchId } = req.params;
  res.set('Content-Type', 'image/gif');
  res.send(TRACKING_PIXEL_GIF);

  try {
    const { supabase } = require('./services/supabase');
    await supabase
      .from('match_queue')
      .update({ email_opened_at: new Date().toISOString() })
      .eq('id', matchId)
      .is('email_opened_at', null);
  } catch (e) {
    console.warn('[NOTIFIER-EMAIL] No se pudo registrar apertura de email para match', matchId, e);
  }
});

// Redirect trackeado para los deep links wa.me embebidos en el email de notificación
app.get('/api/notifications/email/click/:matchId', async (req, res) => {
  const { matchId } = req.params;
  const { supabase } = require('./services/supabase');

  try {
    const { data: match, error } = await supabase
      .from('match_queue')
      .select('whatsapp_sender_phone, whatsapp_sender_name, whatsapp_group_name, raw_message_text, property:properties(*)')
      .eq('id', matchId)
      .single();

    if (error || !match) {
      return res.status(404).send('Match no encontrado.');
    }

    await supabase
      .from('match_queue')
      .update({ email_clicked_at: new Date().toISOString() })
      .eq('id', matchId)
      .is('email_clicked_at', null);

    const { buildWhatsAppMessage } = require('./services/notifier-email');
    const message = buildWhatsAppMessage(match.whatsapp_group_name, match.property, match.whatsapp_sender_name, match.raw_message_text);
    const phone = (match.whatsapp_sender_phone || '').replace(/\D/g, '');
    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;

    res.redirect(302, waUrl);
  } catch (e: any) {
    console.error('[NOTIFIER-EMAIL] Error al procesar redirect de click:', e.message || e);
    res.status(500).send('Error al procesar el link.');
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

  let sessions: any[] = [];
  try {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('*');

    if (error) throw error;
    sessions = data || [];
  } catch (e) {
    console.warn('[MAIN - SUPABASE] No se pudo recuperar sesiones para arranque inicial:', e);
  }

  // Inicializar sesiones y catálogos de cada sesión registrada
  for (const session of sessions) {
    const tenantId = session.tenant_id;
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

    // Iniciar conexión de WhatsApp persistente para el Tenant
    initTenantSession(tenantId, {
      onMessage: async (message, senderName, groupName, senderPhone, tId) => {
        messageQueue.enqueue(async () => {
          await coordinator.handleIncomingMessage(message.body, senderName, groupName, senderPhone, message.id, tId);
        }, tId);
      }
    }).catch(err => {
      console.error(`[ARRANQUE] Fallo de inicio de WhatsApp para tenant ${tenantId}:`, err);
    });
  }

  // Iniciar servicio de cotización de Dólar Blue (dinámico y horaria)
  startDolarService();

  // Iniciar servicio de desconexión de sesiones de WhatsApp de prueba (KAN-53)
  startSessionCleanupService();

  // Iniciar servicio notificador consolidado según el canal configurado (NOTIFICATION_CHANNEL)
  if (config.notificationChannel === 'email') {
    startEmailNotificationService();
  } else {
    startNotificationService();
  }

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
