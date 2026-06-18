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
import { Property } from './services/sheets';
import { loadCatalogFromDisk, saveCatalogToDisk, processExcelBuffer } from './services/excel';
import { coordinator } from './services/coordinator';
import { messageQueue } from './utils/queue';
import { startNotificationService } from './services/notifier';

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
 */
async function tenantAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.cookies?.housematch_session;
  if (!token) {
    return res.status(401).json({ error: 'No autorizado: Sesión no encontrada' });
  }

  const { supabase, getTenantClient } = require('./services/supabase');
  const jwt = require('jsonwebtoken');
  const { config } = require('./config/env');

  try {
    const decoded = jwt.verify(token, config.supabaseJwtSecret) as any;
    const tenantId = decoded.sub;
    const sessionToken = decoded.session_token;

    // Validar en base de datos maestra si el token de sesión sigue activo
    const { data: tenant, error } = await supabase
      .from('Tenant')
      .select('id, active_session_token')
      .eq('id', tenantId)
      .maybeSingle();

    if (error) throw error;

    if (!tenant || tenant.active_session_token !== sessionToken) {
      res.clearCookie('housematch_session');
      return res.status(401).json({ error: 'Sesión invalidada o iniciada en otro dispositivo' });
    }

    (req as any).tenantId = tenantId;
    (req as any).supabaseClient = getTenantClient(token);
    next();
  } catch (err: any) {
    console.error('Error en tenantAuthMiddleware:', err);
    res.clearCookie('housematch_session');
    res.status(401).json({ error: 'Sesión expirada o inválida' });
  }
}

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN (PÚBLICOS)
// ==========================================

/**
 * Consulta el estado de sesión actual para el token provisto por cookie
 */
app.get('/api/auth/session', async (req, res) => {
  const token = req.cookies?.housematch_session;
  if (!token) {
    return res.json({ authenticated: false });
  }

  const { supabase } = require('./services/supabase');
  const jwt = require('jsonwebtoken');
  const { config } = require('./config/env');

  try {
    const decoded = jwt.verify(token, config.supabaseJwtSecret) as any;
    const tenantId = decoded.sub;
    const sessionToken = decoded.session_token;

    const { data: tenant, error } = await supabase
      .from('Tenant')
      .select('id, name, phone_number, active_session_token')
      .eq('id', tenantId)
      .maybeSingle();

    if (error) throw error;

    if (tenant && tenant.active_session_token === sessionToken) {
      res.json({
        authenticated: true,
        tenant: {
          id: tenant.id,
          name: tenant.name || 'Inmobiliaria',
          number: tenant.phone_number ? tenant.phone_number.split('@')[0] : ''
        }
      });
    } else {
      res.clearCookie('housematch_session');
      res.json({ authenticated: false });
    }
  } catch (err: any) {
    res.clearCookie('housematch_session');
    res.json({ authenticated: false });
  }
});

/**
 * Solicita el envío de un código OTP por WhatsApp al número de bot provisto
 */
app.post('/api/auth/request-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Número de teléfono requerido' });

  const cleanPhone = phone.replace(/\D/g, '');
  const jid = cleanPhone + '@s.whatsapp.net';

  const { supabase } = require('./services/supabase');
  const { sendWhatsAppMessage } = require('./services/whatsapp');

  try {
    const { data: tenant, error } = await supabase
      .from('Tenant')
      .select('*')
      .eq('phone_number', jid)
      .maybeSingle();

    if (error) throw error;

    if (!tenant) {
      return res.status(404).json({ error: 'Número de WhatsApp no registrado. Conecta un nuevo bot primero.' });
    }

    // Generar OTP de 6 dígitos
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min validez

    await supabase
      .from('Tenant')
      .update({
        otp_code: otp,
        otp_expires_at: expiresAt
      })
      .eq('id', tenant.id);

    // Despachar el OTP por chat privado mediante la sesión del propio bot
    const sent = await sendWhatsAppMessage(tenant.id, cleanPhone, `🔐 Código de verificación HouseMatch: *${otp}*\n\nEste código es de un solo uso y expira en 5 minutos.`);

    if (!sent) {
      return res.status(500).json({ error: 'No se pudo enviar el OTP. Valida que tu bot esté en línea.' });
    }

    res.json({ success: true, message: 'OTP enviado.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error interno al procesar OTP.' });
  }
});

/**
 * Verifica el código OTP y vincula la sesión actual mediante cookie HttpOnly
 */
app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Teléfono y OTP requeridos' });

  const cleanPhone = phone.replace(/\D/g, '');
  const jid = cleanPhone + '@s.whatsapp.net';

  const { supabase, generateTenantToken } = require('./services/supabase');

  try {
    const { data: tenant, error } = await supabase
      .from('Tenant')
      .select('*')
      .eq('phone_number', jid)
      .maybeSingle();

    if (error) throw error;

    if (!tenant || tenant.otp_code !== otp) {
      return res.status(400).json({ error: 'Código OTP incorrecto.' });
    }

    const expires = new Date(tenant.otp_expires_at).getTime();
    if (Date.now() > expires) {
      return res.status(400).json({ error: 'Código OTP expirado.' });
    }

    // Generar nuevo active_session_token (single session enforcement)
    const newSessionToken = randomUUID();

    // Actualizar tenant en la base de datos
    await supabase
      .from('Tenant')
      .update({
        active_session_token: newSessionToken,
        otp_code: null,
        otp_expires_at: null
      })
      .eq('id', tenant.id);

    // Firmar JWT
    const token = generateTenantToken(tenant.id, newSessionToken);

    // Enviar cookie HttpOnly y Secure
    res.cookie('housematch_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error interno al validar OTP.' });
  }
});

/**
 * Registra un Tenant provisional, configura su sesión y devuelve el token mediante cookie
 */
app.post('/api/auth/register-new', async (req, res) => {
  const { supabase, generateTenantToken } = require('./services/supabase');

  try {
    // Autolimpiar provisionales inactivos de más de 1 hora para evitar colmatar el límite de 10
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    try {
      const { data: oldProv } = await supabase
        .from('Tenant')
        .select('id')
        .eq('name', 'Provisional')
        .is('phone_number', null)
        .lt('created_at', oneHourAgo);

      if (oldProv && oldProv.length > 0) {
        const oldIds = oldProv.map((t: any) => t.id);
        await supabase.from('Match').delete().in('tenant_id', oldIds);
        await supabase.from('Message').delete().in('tenant_id', oldIds);
        await supabase.from('Property').delete().in('tenant_id', oldIds);
        await supabase.from('WhatsappSession').delete().in('tenant_id', oldIds);
        await supabase.from('Tenant').delete().in('id', oldIds);
        console.log(`[CLEANUP] Limpiados ${oldIds.length} tenants provisionales inactivos.`);
      }
    } catch (cleanErr) {
      console.error('[CLEANUP] Error al autolimpiar provisionales:', cleanErr);
    }

    // Validar límite estricto de 10 Tenants
    const { count, error: countErr } = await supabase
      .from('Tenant')
      .select('*', { count: 'exact', head: true });

    if (countErr) throw countErr;

    if (count && count >= 10) {
      return res.status(400).json({ error: 'Límite de 10 licencias activas alcanzado en el sistema.' });
    }

    const tempId = randomUUID();
    const newSessionToken = randomUUID();

    // Crear un Tenant provisional
    await supabase
      .from('Tenant')
      .insert({
        id: tempId,
        name: 'Provisional',
        active_session_token: newSessionToken
      });

    // Inicializar sesión de WhatsApp provisional
    initTenantSession(tempId, {
      onMessage: async (message, senderName, groupName, senderPhone, tenantId) => {
        messageQueue.enqueue(async () => {
          await coordinator.handleIncomingMessage(message.body, senderName, groupName, senderPhone, message.id, tenantId);
        }, tenantId);
      }
    }).catch(err => {
      console.error(`[MAIN] Fallo inicialización provisional tenant ${tempId}:`, err);
    });

    // Firmar JWT y establecer cookie
    const token = generateTenantToken(tempId, newSessionToken);
    res.cookie('housematch_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días
    });

    res.json({ success: true, tenantId: tempId });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error interno al crear bot.' });
  }
});

/**
 * Cierra la sesión activa en el frontend, limpia la cookie y desconecta WhatsApp
 */
app.post('/api/auth/logout', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { logoutTenantSession } = require('./services/whatsapp');
  try {
    await logoutTenantSession(tenantId);
    res.clearCookie('housematch_session');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error al desconectar sesión.' });
  }
});

// ==========================================
// ENDPOINTS DE API PROTEGIDOS POR IP (TENANT)
// ==========================================

app.get('/api/status', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { tenantRedirects, initTenantSession } = require('./services/whatsapp');
  const { supabase, generateTenantToken } = require('./services/supabase');

  // 1. Validar si existe una redirección porque este tenant provisorio escaneó un QR de un número ya registrado
  const redirectId = tenantRedirects.get(tenantId);
  if (redirectId) {
    try {
      const { data: extTenant } = await supabase
        .from('Tenant')
        .select('active_session_token, phone_number')
        .eq('id', redirectId)
        .maybeSingle();

      if (extTenant) {
        if (extTenant.active_session_token) {
          // Ya tiene una sesión web activa en otro dispositivo -> Forzar OTP
          tenantRedirects.delete(tenantId);

          const otp = Math.floor(100000 + Math.random() * 900000).toString();
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          await supabase
            .from('Tenant')
            .update({ otp_code: otp, otp_expires_at: expiresAt })
            .eq('id', redirectId);

          const { sendWhatsAppMessage } = require('./services/whatsapp');
          const cleanPhone = extTenant.phone_number.split('@')[0];
          await sendWhatsAppMessage(redirectId, cleanPhone, `🔐 Código de verificación HouseMatch: *${otp}*\n\nEste código es de un solo uso y expira en 5 minutos.`);

          // Limpiar la sesión provisoria de la base de datos
          await supabase.from('Tenant').delete().eq('id', tenantId);

          return res.json({
            status: 'REQUIRES_OTP',
            phone: cleanPhone
          });
        } else {
          // No tiene sesión web activa -> Redirigir/iniciar sesión automáticamente
          tenantRedirects.delete(tenantId);
          const newSessionToken = randomUUID();
          await supabase
            .from('Tenant')
            .update({ active_session_token: newSessionToken })
            .eq('id', redirectId);

          const token = generateTenantToken(redirectId, newSessionToken);
          res.cookie('housematch_session', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000
          });

          await supabase.from('Tenant').delete().eq('id', tenantId);

          return res.json({
            status: 'REDIRECT',
            tenantId: redirectId
          });
        }
      }
    } catch (err) {
      console.error('[STATUS] Error al procesar redirección de tenant:', err);
    }
  }

  // 2. Si no hay redirección, comprobar el estado de sesión de WhatsApp
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
    saveCatalogToDisk(catalog, tenantId);
    coordinator.setCatalog(tenantId, catalog);

    const { syncPropertiesToDatabase } = require('./services/sheets');
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
      .from('Match')
      .select(`
        *,
        property:Property(*),
        message:Message(*)
      `)
      .order('fecha', { ascending: false })
      .limit(50);

    if (error) throw error;

    const mappedMatches = dbMatches.map((m: any) => ({
      id: m.id,
      fecha: new Date(m.fecha).toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' }),
      originalText: m.message.body,
      contactSender: m.message.sender,
      groupName: m.message.groupName,
      property: {
        domicilio: m.property.domicilio,
        pisoLote: m.property.pisoLote || '',
        precio: m.property.precio,
        moneda: m.property.moneda,
        expensas: m.property.expensas,
        dormitorios: m.property.dormitorios,
        caracteristicas: m.property.caracteristicas || '',
        contacto: m.property.contacto || '',
        zona: m.property.zona,
        operacion: m.property.operacion,
        tipo_propiedad: m.property.tipoPropiedad,
        sheetName: m.property.sheetName
      },
      matchDetails: m.matchDetails,
      userReviewStatus: m.userReviewStatus || 'PENDING',
      feedbackReason: m.feedbackReason || null
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
      .from('Match')
      .update({
        userReviewStatus: status,
        feedbackReason: status === 'REJECTED' ? (reason || 'No especificado') : null
      })
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error al actualizar el feedback de match:', error);
    res.status(500).json({ error: error.message || 'Error interno al guardar feedback.' });
  }
});

// ==========================================
// FUNCIÓN PRINCIPAL DE ARRANQUE (MAIN)
// ==========================================

async function main() {
  console.log('Iniciando HouseMatch MVP Multi-Tenant con Dashboard...');

  const { supabase } = require('./services/supabase');
  const { syncPropertiesToDatabase } = require('./services/sheets');

  let tenants: any[] = [];
  try {
    const { data, error } = await supabase
      .from('Tenant')
      .select('*');

    if (error) throw error;
    tenants = data || [];
  } catch (e) {
    console.warn('[MAIN - SUPABASE] No se pudo recuperar tenants para arranque inicial:', e);
  }

  // Inicializar sesiones y catálogos de cada Tenant registrado
  for (const tenant of tenants) {
    const tenantId = tenant.id;
    if (tenantId === '00000000-0000-0000-0000-000000000000') {
      continue;
    }
    if (!tenant.phone_number) {
      continue;
    }

    let propertyCatalog: Property[] = [];
    try {
      const { data: dbProperties, error: propErr } = await supabase
        .from('Property')
        .select('*')
        .eq('tenant_id', tenantId);

      if (propErr) throw propErr;

      if (dbProperties && dbProperties.length > 0) {
        console.log(`[MAIN - SUPABASE] Catálogo cargado desde Supabase para tenant ${tenantId} (${dbProperties.length} propiedades).`);
        propertyCatalog = dbProperties.map((p: any) => ({
          domicilio: p.domicilio,
          pisoLote: p.pisoLote || '',
          precio: p.precio,
          moneda: p.moneda as any,
          expensas: p.expensas,
          dormitorios: p.dormitorios,
          caracteristicas: p.caracteristicas || '',
          contacto: p.contacto || '',
          zona: p.zona,
          operacion: p.operacion as any,
          tipo_propiedad: p.tipoPropiedad as any,
          sheetName: p.sheetName,
          latitud: p.latitud || undefined,
          longitud: p.longitud || undefined
        }));
      } else {
        propertyCatalog = loadCatalogFromDisk(tenantId);
        console.log(`[MAIN] Catálogo local cargado para tenant ${tenantId} (${propertyCatalog.length} propiedades).`);
        if (propertyCatalog.length > 0) {
          await syncPropertiesToDatabase(propertyCatalog, tenantId);
        }
      }
    } catch (e) {
      console.warn(`[ARRANQUE] Error al sincronizar catálogo del tenant ${tenantId}:`, e);
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
