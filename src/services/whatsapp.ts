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
import { config } from '../config/env';

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

  // Espejo en Supabase (whatsapp_sessions.monitored_groups) para que los grupos
  // seleccionados sobrevivan a un redeploy o a otra instancia del servidor,
  // en vez de vivir solo en el filesystem local.
  const { supabase } = require('./supabase');
  supabase
    .from('whatsapp_sessions')
    .update({ monitored_groups: settings.selectedGroups, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .then(({ error }: any) => {
      if (error) {
        console.error(`[WHATSAPP] Error al guardar grupos monitoreados en Supabase para tenant ${tenantId}:`, error);
      }
    });
}

/**
 * Hidrata la caché local de grupos seleccionados desde Supabase si no existe
 * (ej. tras un redeploy que reinicia el filesystem).
 */
async function hydrateSettingsFromDb(tenantId: string): Promise<void> {
  const settingsPath = getCacheFilePath(`settings_${tenantId}.json`);
  if (fs.existsSync(settingsPath)) return;

  const { supabase } = require('./supabase');
  const { data, error } = await supabase
    .from('whatsapp_sessions')
    .select('monitored_groups')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) {
    console.error(`[WHATSAPP] Error al hidratar grupos monitoreados desde Supabase para tenant ${tenantId}:`, error);
    return;
  }

  if (data?.monitored_groups?.length) {
    try {
      fs.writeFileSync(settingsPath, JSON.stringify({ selectedGroups: data.monitored_groups }, null, 2), 'utf-8');
    } catch (e) {
      console.error(`Error al escribir caché de configuración del tenant ${tenantId}:`, e);
    }
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
export const reconnectTimeouts = new Map<string, NodeJS.Timeout>();
// Deduplica inicializaciones concurrentes del mismo tenant (ej. polling de /api/status
// disparando initTenantSession de nuevo mientras la anterior todavía está cargando
// las credenciales desde Supabase, lo que generaba QRs huérfanos que nunca terminaban de emparejar).
const pendingInits = new Map<string, Promise<WASocket>>();
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
    const cleanNumber = sock.user.id.split('@')[0].split(':')[0];
    const selfJid = `${cleanNumber}@s.whatsapp.net`;
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
export function initTenantSession(tenantId: string, options: WhatsAppClientOptions): Promise<WASocket> {
  if (tenantId === '00000000-0000-0000-0000-000000000000') {
    console.log('[WHATSAPP] Omitiendo inicialización de sesión para el Tenant por Defecto del sistema.');
    return Promise.resolve(null as any);
  }

  // Si ya hay una inicialización en curso para este tenant, reutilizarla en vez de
  // levantar otra sesión de Baileys en paralelo (eso generaba QRs huérfanos que el
  // teléfono nunca lograba emparejar).
  const existingInit = pendingInits.get(tenantId);
  if (existingInit) {
    return existingInit;
  }

  const initPromise = initTenantSessionInternal(tenantId, options).finally(() => {
    pendingInits.delete(tenantId);
  });
  pendingInits.set(tenantId, initPromise);
  return initPromise;
}

async function initTenantSessionInternal(tenantId: string, options: WhatsAppClientOptions): Promise<WASocket> {
  console.log(`[WHATSAPP] Inicializando sesión dinámica para Tenant: ${tenantId}...`);

  // Límite estricto de 10 Tenants / Sesiones activas
  if (activeSessions.size >= 10 && !activeSessions.has(tenantId)) {
    throw new Error('Límite máximo de 10 sesiones de WhatsApp activas alcanzado.');
  }

  await hydrateSettingsFromDb(tenantId);

  const tenantStatus: WhatsAppStatus = { status: 'INITIALIZING' };
  sessionStatuses.set(tenantId, tenantStatus);
  savedOptions = options;

  // Cargar estado de autenticación desde Supabase
  const { state, saveCreds } = await useSupabaseAuthState(tenantId);

  // Congelamiento Baileys (KAN-32): `registered` lo marca Baileys en `true` recién
  // después de un emparejamiento exitoso (escaneo de QR). Si sigue en `false` es porque
  // este tenant nunca terminó de vincular un número — dejarlo seguir generaría un QR
  // nuevo, es decir, el alta de una cuenta de WhatsApp nueva, que es justamente lo que
  // este ticket frena. Los tenants ya emparejados (`registered: true`) siguen
  // reconectando con normalidad; el freeze no los afecta.
  if (config.baileysFrozen && !state.creds.registered) {
    tenantStatus.status = 'DISCONNECTED';
    console.warn(`[WHATSAPP] Alta de cuenta de WhatsApp nueva bloqueada para tenant ${tenantId}: Baileys está congelado (BAILEYS_FROZEN, ver KAN-32).`);
    throw new Error('Congelamiento activo (KAN-32): no se permiten altas de cuentas de WhatsApp nuevas.');
  }

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
          
          const existingTimeout = reconnectTimeouts.get(tenantId);
          if (existingTimeout) clearTimeout(existingTimeout);

          const timeout = setTimeout(() => {
            reconnectTimeouts.delete(tenantId);
            if (activeSessions.get(tenantId) === sock) {
              initTenantSession(tenantId, options).catch(err => {
                console.error(`Error al reconectar tenant ${tenantId}:`, err);
              });
            }
          }, 5000);
          reconnectTimeouts.set(tenantId, timeout);
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
      const userNumber = userJid ? userJid.split('@')[0].split(':')[0] : 'Desconocido';
      // `name` es el nombre que el propio dueño de la cuenta le puso al contacto en su
      // WhatsApp (normalmente vacío para uno mismo); `notify` es el nombre de perfil
      // que la cuenta configuró y llega directamente en el pairing.
      tenantStatus.user = {
        name: sock.user?.name || (sock.user as any)?.notify || 'Usuario',
        number: userNumber
      };

      console.log(`\n=========================================`);
      console.log(`¡TENANT ${tenantId} CONECTADO COMO: ${tenantStatus.user.name} (${userNumber})!`);
      console.log(`=========================================\n`);

      // Registrar o sincronizar la sesión en whatsapp_sessions
      const { supabase } = require('./supabase');
      try {
        const jidFormatted = userNumber + '@s.whatsapp.net';

        // Buscar si ya existe una sesión registrada con este número de WhatsApp
        const { data: existingSession, error: selectErr } = await supabase
          .from('whatsapp_sessions')
          .select('tenant_id')
          .eq('phone_number', jidFormatted)
          .maybeSingle();

        if (selectErr) throw selectErr;

        const targetTenantId = existingSession ? existingSession.tenant_id : tenantId;

        if (existingSession && existingSession.tenant_id !== tenantId) {
          console.log(`[WHATSAPP] Migrando sesión de tenant provisorio ${tenantId} a consolidado ${existingSession.tenant_id}...`);

          // 1. Obtener auth_creds del tenant provisorio
          const { data: provisionalSession } = await supabase
            .from('whatsapp_sessions')
            .select('auth_creds')
            .eq('tenant_id', tenantId)
            .maybeSingle();

          if (provisionalSession?.auth_creds) {
            // 2. Copiar auth_creds al tenant consolidado
            await supabase
              .from('whatsapp_sessions')
              .upsert({
                tenant_id: existingSession.tenant_id,
                auth_creds: provisionalSession.auth_creds,
                updated_at: new Date().toISOString()
              }, { onConflict: 'tenant_id' });

            // 3. Limpiar auth_creds del provisorio
            await supabase
              .from('whatsapp_sessions')
              .update({ auth_creds: null, status: 'disconnected' })
              .eq('tenant_id', tenantId);
          }

          // Actualizar estado de la sesión consolidada
          await supabase
            .from('whatsapp_sessions')
            .update({
              status: 'connected',
              phone_number: jidFormatted,
              updated_at: new Date().toISOString()
            })
            .eq('tenant_id', existingSession.tenant_id);

          // Registrar la redirección para que el index.ts del api pueda actualizar la cookie del navegador
          tenantRedirects.set(tenantId, existingSession.tenant_id);

          // 4. Cerrar el socket provisorio (para evitar que siga escribiendo con el tenant_id viejo)
          activeSessions.delete(tenantId);
          sessionStatuses.delete(tenantId);
          try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.ev.removeAllListeners('messages.upsert');
            sock.end(undefined);
          } catch (e) {}

          // 5. Iniciar la sesión consolidada con el ID correcto
          console.log(`[WHATSAPP] Inicializando sesión consolidada para tenant ${existingSession.tenant_id}`);
          initTenantSession(existingSession.tenant_id, options).catch(err => {
            console.error(`[WHATSAPP] Error al iniciar sesión consolidada ${existingSession.tenant_id}:`, err);
          });

          return;
        } else {
          // Es un tenant nuevo o los IDs coinciden
          await supabase
            .from('whatsapp_sessions')
            .upsert({
              tenant_id: tenantId,
              phone_number: jidFormatted,
              status: 'connected',
              updated_at: new Date().toISOString()
            }, { onConflict: 'tenant_id' });
        }

        // Cargar catálogo de Supabase en memoria del coordinador inmediatamente al conectar
        const { coordinator } = require('./coordinator');
        const { data: dbProps } = await supabase
          .from('properties')
          .select('*')
          .eq('tenant_id', targetTenantId);

        if (dbProps && dbProps.length > 0) {
          const propertyCatalog = dbProps.map((p: any) => ({
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
  const timeout = reconnectTimeouts.get(tenantId);
  if (timeout) {
    clearTimeout(timeout);
    reconnectTimeouts.delete(tenantId);
  }

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
