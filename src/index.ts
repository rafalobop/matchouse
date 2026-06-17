import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
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
 * Middleware para autenticación silenciosa basada en IP (IP-to-Tenant Binding)
 * Valida la ventana de 12 horas desde la vinculación
 */
async function tenantAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = getClientIp(req);
  const { supabase } = require('./services/supabase');

  try {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

    // Buscar un Tenant cuya IP coincida y esté dentro del rango de las 12 horas
    const { data: tenant, error } = await supabase
      .from('Tenant')
      .select('id')
      .eq('associated_ip', ip)
      .gt('ip_bound_at', twelveHoursAgo)
      .maybeSingle();

    if (error) throw error;

    if (!tenant) {
      return res.status(401).json({ error: 'No autorizado o sesión expirada' });
    }

    // Inyectar tenantId en la petición para el uso de los endpoints subsecuentes
    (req as any).tenantId = tenant.id;
    next();
  } catch (err: any) {
    console.error('Error en tenantAuthMiddleware:', err);
    res.status(500).json({ error: 'Error interno de autenticación por IP.' });
  }
}

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN (PÚBLICOS)
// ==========================================

/**
 * Consulta el estado de sesión actual para la IP solicitante
 */
app.get('/api/auth/session', async (req, res) => {
  const ip = getClientIp(req);
  const { supabase } = require('./services/supabase');

  try {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

    const { data: tenant, error } = await supabase
      .from('Tenant')
      .select('id, name, phone_number, ip_bound_at')
      .eq('associated_ip', ip)
      .gt('ip_bound_at', twelveHoursAgo)
      .maybeSingle();

    if (error) throw error;

    if (tenant) {
      res.json({
        authenticated: true,
        tenant: {
          id: tenant.id,
          name: tenant.name || 'Inmobiliaria',
          number: tenant.phone_number ? tenant.phone_number.split('@')[0] : ''
        }
      });
    } else {
      res.json({ authenticated: false });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error de base de datos' });
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
 * Verifica el código OTP y vincula la IP actual del cliente al Tenant
 */
app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Teléfono y OTP requeridos' });

  const cleanPhone = phone.replace(/\D/g, '');
  const jid = cleanPhone + '@s.whatsapp.net';
  const ip = getClientIp(req);

  const { supabase } = require('./services/supabase');

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

    // 1. Quitar la vinculación previa de esta IP si estaba en uso por otro Tenant
    await supabase
      .from('Tenant')
      .update({ associated_ip: null })
      .eq('associated_ip', ip);

    // 2. Vincular IP al tenant actual y resetear OTP
    await supabase
      .from('Tenant')
      .update({
        associated_ip: ip,
        ip_bound_at: new Date().toISOString(),
        otp_code: null,
        otp_expires_at: null
      })
      .eq('id', tenant.id);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error interno al validar OTP.' });
  }
});

/**
 * Registra un Tenant provisional y crea una sesión de WhatsApp para escaneo
 */
app.post('/api/auth/register-new', async (req, res) => {
  const ip = getClientIp(req);
  const { supabase } = require('./services/supabase');

  try {
    // Validar límite estricto de 10 Tenants
    const { count, error: countErr } = await supabase
      .from('Tenant')
      .select('*', { count: 'exact', head: true });

    if (countErr) throw countErr;

    if (count && count >= 10) {
      return res.status(400).json({ error: 'Límite de 10 licencias activas alcanzado en el sistema.' });
    }

    // Desvincular esta IP si estuviera en uso
    await supabase
      .from('Tenant')
      .update({ associated_ip: null })
      .eq('associated_ip', ip);

    // Crear un Tenant provisional
    const tempId = randomUUID();
    await supabase
      .from('Tenant')
      .insert({
        id: tempId,
        name: 'Provisional',
        associated_ip: ip,
        ip_bound_at: new Date().toISOString()
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

    res.json({ success: true, tenantId: tempId });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error interno al crear bot.' });
  }
});

// ==========================================
// ENDPOINTS DE API PROTEGIDOS POR IP (TENANT)
// ==========================================

app.get('/api/status', tenantAuthMiddleware, (req, res) => {
  const tenantId = (req as any).tenantId;
  const status = sessionStatuses.get(tenantId) || { status: 'DISCONNECTED' };
  res.json(status);
});

app.post('/api/whatsapp/restart', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  try {
    await logoutTenantSession(tenantId);

    // Volver a inicializar
    initTenantSession(tenantId, {
      onMessage: async (message, senderName, groupName, senderPhone, tId) => {
        messageQueue.enqueue(async () => {
          await coordinator.handleIncomingMessage(message.body, senderName, groupName, senderPhone, message.id, tId);
        }, tId);
      }
    }).catch(err => {
      console.error(`Error al reiniciar tenant ${tenantId}:`, err);
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al reiniciar cliente.' });
  }
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
  const { supabase } = require('./services/supabase');
  try {
    const { data: dbMatches, error } = await supabase
      .from('Match')
      .select(`
        *,
        property:Property(*),
        message:Message(*)
      `)
      .eq('tenant_id', tenantId)
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
  const { supabase } = require('./services/supabase');

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
      .eq('id', id)
      .eq('tenant_id', tenantId);

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

  // Diagnóstico de entorno
  console.log('[DIAGNOSTIC] PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);

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
      console.log(`[ARRANQUE] Omitiendo inicialización del Tenant por Defecto del sistema (${tenantId})`);
      continue;
    }
    console.log(`[ARRANQUE] Inicializando datos y WhatsApp para Tenant: ${tenant.name} (${tenantId})`);

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
