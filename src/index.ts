import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
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
import { startDolarService } from './services/dolar';

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

/**
 * Middleware para autenticación basada en Cookie JWT (Single Session & RLS)
 * TODO: auth-phase — validación contra tabla Tenant desactivada; reimplementar con Supabase Auth magic link
 */
async function tenantAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  // TODO: auth-phase — bypass temporal: no valida sesión contra BD mientras se reimplementa auth
  const { supabase } = require('./services/supabase');
  const token = req.cookies?.housematch_session;
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      const { config } = require('./config/env');
      const decoded = jwt.verify(token, config.supabaseJwtSecret) as any;
      (req as any).tenantId = decoded.sub;
    } catch {
      (req as any).tenantId = 'anonymous';
    }
  } else {
    (req as any).tenantId = 'anonymous';
  }
  (req as any).supabaseClient = supabase;
  next();
}

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN (PÚBLICOS)
// ==========================================

/**
 * Consulta el estado de sesión actual para el token provisto por cookie
 * TODO: auth-phase — reimplementar con Supabase Auth magic link
 */
app.get('/api/auth/session', (req, res) => {
  // TODO: auth-phase — reimplementar con Supabase Auth magic link
  res.status(503).json({ error: 'Auth en mantenimiento — próxima fase' });
});

/**
 * Solicita el envío de un código OTP por WhatsApp al número de bot provisto
 * TODO: auth-phase — reimplementar con Supabase Auth magic link
 */
app.post('/api/auth/request-otp', (req, res) => {
  // TODO: auth-phase — reimplementar con Supabase Auth magic link
  res.status(503).json({ error: 'Auth en mantenimiento — próxima fase' });
});

/**
 * Verifica el código OTP y vincula la sesión actual mediante cookie HttpOnly
 * TODO: auth-phase — reimplementar con Supabase Auth magic link
 */
app.post('/api/auth/verify-otp', (req, res) => {
  // TODO: auth-phase — reimplementar con Supabase Auth magic link
  res.status(503).json({ error: 'Auth en mantenimiento — próxima fase' });
});

/**
 * Registra un Tenant provisional, configura su sesión y devuelve el token mediante cookie
 * TODO: auth-phase — reimplementar con Supabase Auth magic link
 */
app.post('/api/auth/register-new', (req, res) => {
  // TODO: auth-phase — reimplementar con Supabase Auth magic link
  res.status(503).json({ error: 'Auth en mantenimiento — próxima fase' });
});

/**
 * Cierra la sesión activa en el frontend, limpia la cookie y desconecta WhatsApp
 * TODO: auth-phase — reimplementar con Supabase Auth magic link
 */
app.post('/api/auth/logout', (req, res) => {
  // TODO: auth-phase — reimplementar con Supabase Auth magic link
  res.status(503).json({ error: 'Auth en mantenimiento — próxima fase' });
});

// ==========================================
// ENDPOINTS DE API PROTEGIDOS POR IP (TENANT)
// ==========================================

app.get('/api/status', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { tenantRedirects, initTenantSession } = require('./services/whatsapp');

  // TODO: auth-phase — lógica de redirección provisional eliminada (usaba Tenant.active_session_token / otp_code que no existen en nuevo esquema)

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
    const { error } = await supabase
      .from('match_queue')
      .update({
        user_review_status: status,
        feedback_reason: status === 'REJECTED' ? (reason || 'No especificado') : null
      })
      .eq('id', id);

    if (error) throw error;

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

  // Iniciar servicio notificador consolidado (corre cada 10 min por defecto)
  startNotificationService();

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
