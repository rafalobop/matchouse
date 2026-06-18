import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import { isRealEstateRequest } from '../utils/filter';
import { useSupabaseAuthState, clearSupabaseSession } from './supabaseAuth';

export interface Settings {
  selectedGroups: string[];
}

function getCacheFilePath(filename: string): string {
  const cacheDir = path.join(process.cwd(), 'cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return path.join(cacheDir, filename);
}

export function loadSettings(tenantId: string): Settings {
  const settingsPath = getCacheFilePath(`settings_${tenantId}.json`);
  if (fs.existsSync(settingsPath)) {
    try {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (e) {
      console.error(`Error al cargar configuración del tenant ${tenantId}:`, e);
    }
  }
  return { selectedGroups: [] };
}

export function saveSettings(tenantId: string, settings: Settings): void {
  const settingsPath = getCacheFilePath(`settings_${tenantId}.json`);
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error(`Error al guardar configuración del tenant ${tenantId}:`, e);
  }
}

function getGroupsCachePath(tenantId: string): string {
  return getCacheFilePath(`groups_cache_${tenantId}.json`);
}

function loadGroupsCache(tenantId: string): { id: string; name: string }[] {
  const cachePath = getGroupsCachePath(tenantId);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    } catch (e) {
      console.error(`Error al cargar caché de grupos del tenant ${tenantId}:`, e);
    }
  }
  return [];
}

export interface WhatsAppStatus {
  status: 'INITIALIZING' | 'DISCONNECTED' | 'QR_RECEIVED' | 'AUTHENTICATED' | 'CONNECTED';
  qrDataUrl?: string;
  syncPercentage?: number;
  syncMessage?: string;
  user?: {
    name: string;
    number: string;
  };
}

// Mapas para almacenar sesiones y estados activos por tenant_id
export const activeSessions = new Map<string, WASocket>();
export const sessionStatuses = new Map<string, WhatsAppStatus>();
export const tenantRedirects = new Map<string, string>(); // tempId -> consolidatedId
let savedOptions: WhatsAppClientOptions | null = null;

export interface WhatsAppClientOptions {
  onMessage: (
    message: { id?: string; body: string },
    senderName: string,
    groupName: string,
    senderPhone: string,
    tenantId: string
  ) => Promise<void>;
}

/**
 * Envía una notificación de match consolidada al chat propio del tenant
 */
export async function sendWhatsAppNotification(tenantId: string, message: string): Promise<void> {
  const sock = activeSessions.get(tenantId);
  const status = sessionStatuses.get(tenantId);
  if (!sock || !sock.user?.id || status?.status !== 'CONNECTED') {
    console.warn(`[WHATSAPP] No se puede enviar notificación para el tenant ${tenantId}: Cliente no conectado.`);
    return;
  }
  try {
    const selfJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    await sock.sendMessage(selfJid, { text: message });
    console.log(`[WHATSAPP] Notificación enviada al usuario conectado del tenant ${tenantId} (${selfJid}).`);
  } catch (error) {
    console.error(`[WHATSAPP] Error al enviar notificación de match para tenant ${tenantId}:`, error);
  }
}

/**
 * Envía un mensaje directo (ej. código OTP de verificación) a un teléfono
 */
export async function sendWhatsAppMessage(tenantId: string, toPhone: string, message: string): Promise<boolean> {
  const sock = activeSessions.get(tenantId);
  if (!sock || !sock.user?.id) {
    console.warn(`[WHATSAPP] No se puede enviar mensaje OTP para tenant ${tenantId}: Socket no disponible.`);
    return false;
  }
  try {
    // Asegurar formato JID de WhatsApp
    const cleanPhone = toPhone.replace(/\D/g, '');
    const jid = cleanPhone.includes('@s.whatsapp.net') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`[WHATSAPP] Mensaje directo enviado desde tenant ${tenantId} a ${jid}.`);
    return true;
  } catch (error) {
    console.error(`[WHATSAPP] Error al enviar mensaje directo desde tenant ${tenantId}:`, error);
    return false;
  }
}

/**
 * Inicializa la sesión de WhatsApp de un Tenant de forma dinámica
 */
export async function initTenantSession(tenantId: string, options: WhatsAppClientOptions): Promise<WASocket> {
  if (tenantId === '00000000-0000-0000-0000-000000000000') {
    console.log('[WHATSAPP] Omitiendo inicialización de sesión para el Tenant por Defecto del sistema.');
    return null as any;
  }

  console.log(`[WHATSAPP] Inicializando sesión dinámica para Tenant: ${tenantId}...`);
  
  // Límite estricto de 10 Tenants / Sesiones activas
  if (activeSessions.size >= 10 && !activeSessions.has(tenantId)) {
    throw new Error('Límite máximo de 10 sesiones de WhatsApp activas alcanzado.');
  }

  const tenantStatus: WhatsAppStatus = { status: 'INITIALIZING' };
  sessionStatuses.set(tenantId, tenantStatus);
  savedOptions = options;

  // Cargar estado de autenticación desde Supabase
  const { state, saveCreds } = await useSupabaseAuthState(tenantId);

  // Obtener la versión de WhatsApp Web más reciente
  let version: any = [2, 3000, 1017531287];
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (err) {
    console.warn('[WHATSAPP] Error al recuperar versión de Baileys, usando fallback.');
  }

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    logger: pino({ level: 'error' }),
  });

  activeSessions.set(tenantId, sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      tenantStatus.status = 'QR_RECEIVED';
      try {
        tenantStatus.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error(`Error al generar QR DataURL para tenant ${tenantId}:`, err);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isQrTimeout = statusCode === 408 || lastDisconnect?.error?.message?.includes('QR refs attempts ended');
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !isQrTimeout;

      if (isQrTimeout) {
        console.log(`[WHATSAPP] Expiró el tiempo límite para escanear el QR del tenant ${tenantId}. Se detiene reconexión automática.`);
      } else {
        console.log(`Conexión cerrada del tenant ${tenantId}. Razón:`, lastDisconnect?.error, `, reconectando:`, shouldReconnect);
      }

      if (activeSessions.get(tenantId) === sock) {
        tenantStatus.status = 'DISCONNECTED';
        tenantStatus.user = undefined;
      }

      if (shouldReconnect) {
        if (activeSessions.get(tenantId) === sock) {
          console.log(`[WHATSAPP] Reintentando conexión del tenant ${tenantId} en 5 segundos...`);
          setTimeout(() => {
            if (activeSessions.get(tenantId) === sock) {
              initTenantSession(tenantId, options).catch(err => {
                console.error(`Error al reconectar tenant ${tenantId}:`, err);
              });
            }
          }, 5000);
        }
      } else {
        if (activeSessions.get(tenantId) === sock) {
          activeSessions.delete(tenantId);
          sessionStatuses.delete(tenantId);
        }
        // Limpiar sesión en Supabase si se deslogueó o venció el QR
        if (statusCode === DisconnectReason.loggedOut || isQrTimeout) {
          try {
            await clearSupabaseSession(tenantId);
            console.log(`[WHATSAPP] Sesión eliminada en Supabase para tenant ${tenantId} debido a logout o expiración.`);
          } catch (err) {
            console.warn(`[WHATSAPP] No se pudo borrar la sesión en Supabase del tenant ${tenantId}:`, err);
          }
        }
      }
    } else if (connection === 'open') {
      if (activeSessions.get(tenantId) !== sock) {
        console.log(`[WHATSAPP] Conexión abierta detectada de socket inactivo para tenant ${tenantId}. Cerrándola.`);
        try { sock.end(undefined); } catch (e) {}
        return;
      }

      tenantStatus.status = 'CONNECTED';
      tenantStatus.qrDataUrl = undefined;

      const userJid = sock.user?.id;
      const userNumber = userJid ? userJid.split(':')[0] : 'Desconocido';
      tenantStatus.user = {
        name: sock.user?.name || 'Usuario',
        number: userNumber
      };

      console.log(`\n=========================================`);
      console.log(`¡TENANT ${tenantId} CONECTADO COMO: ${tenantStatus.user.name} (${userNumber})!`);
      console.log(`=========================================\n`);

      // Registrar o sincronizar el Tenant en Supabase
      const { supabase } = require('./supabase');
      try {
        const jidFormatted = userNumber + '@s.whatsapp.net';
        
        // Buscar si ya existe un Tenant registrado con este número de WhatsApp
        const { data: existingTenant, error: selectErr } = await supabase
          .from('Tenant')
          .select('id')
          .eq('phone_number', jidFormatted)
          .maybeSingle();

        if (selectErr) throw selectErr;

        const targetTenantId = existingTenant ? existingTenant.id : tenantId;

        if (existingTenant && existingTenant.id !== tenantId) {
          // El número de teléfono ya está registrado bajo otro tenantId (por ejemplo de un reinicio anterior).
          // Re-asociamos la sesión activa en memoria al ID consolidado de la base de datos para evitar duplicados.
          console.log(`[WHATSAPP] Mapeando tenant provisorio ${tenantId} -> consolidado ${existingTenant.id}`);
          activeSessions.delete(tenantId);
          sessionStatuses.delete(tenantId);
          
          activeSessions.set(existingTenant.id, sock);
          sessionStatuses.set(existingTenant.id, tenantStatus);

          // Registrar la redirección para que el index.ts del api pueda actualizar la cookie del navegador
          tenantRedirects.set(tenantId, existingTenant.id);
          
          await supabase
            .from('Tenant')
            .update({
              name: sock.user?.name || 'Inmobiliaria'
            })
            .eq('id', existingTenant.id);
        } else {
          // Es un tenant nuevo o los IDs coinciden
          await supabase
            .from('Tenant')
            .upsert({
              id: tenantId,
              name: sock.user?.name || 'Inmobiliaria',
              phone_number: jidFormatted
            });
        }

        // Cargar catálogo de Supabase en memoria del coordinador inmediatamente al conectar
        const { coordinator } = require('./coordinator');
        const { data: dbProps } = await supabase
          .from('Property')
          .select('*')
          .eq('tenant_id', targetTenantId);

        if (dbProps && dbProps.length > 0) {
          const propertyCatalog = dbProps.map((p: any) => ({
            domicilio: p.domicilio,
            pisoLote: p.pisoLote || '',
            precio: p.precio,
            moneda: p.moneda,
            expensas: p.expensas,
            dormitorios: p.dormitorios,
            caracteristicas: p.caracteristicas || '',
            contacto: p.contacto || '',
            zona: p.zona,
            operacion: p.operacion,
            tipo_propiedad: p.tipoPropiedad,
            sheetName: p.sheetName
          }));
          coordinator.setCatalog(targetTenantId, propertyCatalog);
          console.log(`[WHATSAPP - CATALOG] Catálogo de ${propertyCatalog.length} propiedades cargado en coordinador para tenant ${targetTenantId}`);
        } else {
          console.log(`[WHATSAPP - CATALOG] Sin propiedades cargadas en base de datos para tenant ${targetTenantId}`);
        }
      } catch (dbErr) {
        console.error(`[WHATSAPP - SUPABASE] Error al registrar sesión del tenant ${tenantId}:`, dbErr);
      }
    }
  });

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      try {
        const key = msg.key;
        const from = key.remoteJid || '';
        const isGroup = from.endsWith('@g.us');

        if (!isGroup) continue;

        const body = msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption || '';

        if (!body) continue;

        // Pre-filtro Regex local
        if (!isRealEstateRequest(body)) continue;

        // Cargar nombres de grupos en caché del Tenant
        let chatName = 'Chat Grupo';
        const tenantGroups = loadGroupsCache(tenantId);
        const cached = tenantGroups.find(g => g.id === from);

        if (cached) {
          chatName = cached.name;
        } else {
          try {
            const metadata = await sock.groupMetadata(from);
            chatName = metadata.subject || 'Chat Grupo';
            
            // Guardar en caché del tenant
            if (!tenantGroups.some(g => g.id === from)) {
              tenantGroups.push({ id: from, name: chatName });
              const cachePath = getGroupsCachePath(tenantId);
              fs.writeFileSync(cachePath, JSON.stringify(tenantGroups, null, 2), 'utf-8');
            }
          } catch (e) {
            console.warn(`[WHATSAPP] No se pudo obtener metadatos del grupo en upsert del tenant ${tenantId}:`, e);
          }
        }

        // Filtrar por grupos seleccionados por el Tenant
        const settings = loadSettings(tenantId);
        const isGroupSelected = settings.selectedGroups.some(groupId =>
          groupId === from ||
          groupId.toLowerCase() === chatName.toLowerCase()
        );

        if (!isGroupSelected) continue;

        const participantJid = (key as any).participantAlt || key.participant || (msg as any).participant || '';
        let number = '';
        if (participantJid && !participantJid.endsWith('@lid')) {
          number = participantJid.split('@')[0];
        } else {
          number = from.split('@')[0].split('-')[0];
        }
        
        const senderName = msg.pushName || number || 'Remitente Anónimo';
        const senderContact = `@${number} (${senderName})`;

        console.log(`[WhatsApp - Tenant ${tenantId}] De: ${senderName} | Chat: "${chatName}"`);
        console.log(` > Mensaje: "${body.substring(0, 120)}${body.length > 120 ? '...' : ''}"`);

        await options.onMessage({ id: msg.key.id || undefined, body }, senderContact, chatName, number, tenantId);
      } catch (error) {
        console.error(`Error al procesar mensaje entrante de WhatsApp para tenant ${tenantId}:`, error);
      }
    }
  });

  return sock;
}

/**
 * Cierra la sesión activa de un Tenant en memoria y limpia la base de datos
 */
export async function logoutTenantSession(tenantId: string): Promise<void> {
  const sock = activeSessions.get(tenantId);
  if (sock) {
    activeSessions.delete(tenantId);
    sessionStatuses.delete(tenantId);
    try {
      sock.end(undefined);
      console.log(`[WHATSAPP] Conexión de WhatsApp cerrada para tenant ${tenantId}.`);
    } catch (error) {
      console.error(`[WHATSAPP] Error al cerrar conexión del tenant ${tenantId}:`, error);
    }
  }

  // Eliminar la sesión en Supabase
  try {
    await clearSupabaseSession(tenantId);
  } catch (err) {
    console.warn(`[WHATSAPP] No se pudo borrar la sesión en Supabase del tenant ${tenantId}:`, err);
  }
}

/**
 * Recupera todos los chats grupales del tenant actual
 */
export async function getActiveGroups(tenantId: string): Promise<{ id: string; name: string }[]> {
  const sock = activeSessions.get(tenantId);
  const status = sessionStatuses.get(tenantId);
  const cached = loadGroupsCache(tenantId);

  if (!sock || status?.status !== 'CONNECTED') {
    return cached;
  }

  try {
    console.log(`[WHATSAPP] Recuperando grupos participantes para tenant ${tenantId}...`);
    const groupsMetadata = await sock.groupFetchAllParticipating();
    const groups = Object.keys(groupsMetadata).map(jid => ({
      id: jid,
      name: groupsMetadata[jid].subject || 'Grupo sin nombre'
    }));

    // Sincronizar caché
    const updatedCache = [...cached];
    for (const group of groups) {
      const idx = updatedCache.findIndex(g => g.id === group.id);
      if (idx === -1) {
        updatedCache.push(group);
      } else {
        updatedCache[idx].name = group.name;
      }
    }

    const cachePath = getGroupsCachePath(tenantId);
    fs.writeFileSync(cachePath, JSON.stringify(updatedCache, null, 2), 'utf-8');

    return groups;
  } catch (error) {
    console.error(`[WHATSAPP] Error al obtener grupos de WhatsApp para tenant ${tenantId}:`, error);
    return cached;
  }
}
