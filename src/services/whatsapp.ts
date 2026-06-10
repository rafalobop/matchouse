import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as qrcodeTerminal from 'qrcode-terminal';
import * as QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import { isRealEstateRequest } from '../utils/filter';

const SETTINGS_PATH = path.join(process.cwd(), 'settings.json');

export interface Settings {
  selectedGroups: string[]; // Puede ser ID de grupo o nombre
}

export function loadSettings(): Settings {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch (e) {
      console.error('Error al cargar configuración:', e);
    }
  }
  return { selectedGroups: [] };
}

export function saveSettings(settings: Settings): void {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error al guardar configuración:', e);
  }
}

// Caché de grupos persistente
const GROUPS_CACHE_PATH = path.join(process.cwd(), 'groups_cache.json');
let cachedGroups: { id: string; name: string }[] = [];

function loadGroupsCache() {
  if (fs.existsSync(GROUPS_CACHE_PATH)) {
    try {
      cachedGroups = JSON.parse(fs.readFileSync(GROUPS_CACHE_PATH, 'utf-8'));
      console.log(`[WHATSAPP] Caché de grupos cargada: ${cachedGroups.length} grupos registrados.`);
    } catch (e) {
      console.error('Error al cargar caché de grupos:', e);
    }
  }
}

function saveGroupsCache() {
  try {
    fs.writeFileSync(GROUPS_CACHE_PATH, JSON.stringify(cachedGroups, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error al guardar caché de grupos:', e);
  }
}

export function registerGroupFromMessage(id: string, name: string) {
  if (!cachedGroups.some(g => g.id === id)) {
    cachedGroups.push({ id, name });
    saveGroupsCache();
    console.log(`[WHATSAPP PASIVO] Nuevo grupo registrado: "${name}" (${id})`);
  }
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

export let whatsappStatus: WhatsAppStatus = {
  status: 'INITIALIZING'
};

let sockInstance: WASocket | null = null;
let savedOptions: WhatsAppClientOptions | null = null;

export interface WhatsAppClientOptions {
  onMessage: (message: { body: string }, senderName: string, groupName: string, senderPhone: string) => Promise<void>;
}

export async function sendWhatsAppNotification(message: string): Promise<void> {
  if (whatsappStatus.status !== 'CONNECTED' || !sockInstance || !sockInstance.user?.id) {
    console.warn('[WHATSAPP] No se puede enviar notificación: Cliente no conectado.');
    return;
  }
  try {
    const selfJid = sockInstance.user.id.split(':')[0] + '@s.whatsapp.net';
    await sockInstance.sendMessage(selfJid, { text: message });
    console.log(`[WHATSAPP] Notificación enviada al usuario conectado (${selfJid}).`);
  } catch (error) {
    console.error('[WHATSAPP] Error al enviar notificación de match:', error);
  }
}

export async function startWhatsAppClient(options: WhatsAppClientOptions): Promise<WASocket> {
  console.log('Iniciando cliente de WhatsApp Baileys...');
  loadGroupsCache();
  whatsappStatus.status = 'INITIALIZING';
  whatsappStatus.syncPercentage = 0;
  whatsappStatus.syncMessage = 'Inicializando...';
  savedOptions = options;

  const { state, saveCreds } = await useMultiFileAuthState('./.baileys_auth');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'error' }),
  });

  sockInstance = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      whatsappStatus.status = 'QR_RECEIVED';
      console.log('\n=========================================');
      console.log('ESCANEÁ EL CÓDIGO QR CON WHATSAPP PARA LOGUEARTE:');
      console.log('=========================================\n');
      qrcodeTerminal.generate(qr, { small: true });

      try {
        whatsappStatus.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error('Error al generar QR DataURL:', err);
      }
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada debido a:', lastDisconnect?.error, ', reconectando:', shouldReconnect);

      // Solo actualizar el estado global si esta es la instancia activa
      if (sock === sockInstance) {
        whatsappStatus.status = 'DISCONNECTED';
        whatsappStatus.user = undefined;
      }

      if (shouldReconnect) {
        if (sock === sockInstance) {
          console.log('[WHATSAPP] Reintentando conexión en 3 segundos...');
          setTimeout(() => {
            if (sock === sockInstance) {
              startWhatsAppClient(options);
            } else {
              console.log('[WHATSAPP] Ignorando reconexión programada: la instancia de socket ya no es la activa.');
            }
          }, 3000);
        } else {
          console.log('[WHATSAPP] Ignorando reconexión: la instancia de socket cerrada no es la activa.');
        }
      } else {
        if (sock === sockInstance) {
          sockInstance = null;
        }
      }
    } else if (connection === 'open') {
      if (sock !== sockInstance) {
        console.log('[WHATSAPP] Conexión abierta de una instancia no activa. Cerrándola.');
        try { sock.end(undefined); } catch(e) {}
        return;
      }
      whatsappStatus.status = 'CONNECTED';
      whatsappStatus.qrDataUrl = undefined;

      const userJid = sock.user?.id;
      const userNumber = userJid ? userJid.split(':')[0] : 'Desconocido';
      whatsappStatus.user = {
        name: sock.user?.name || 'Usuario',
        number: userNumber
      };

      console.log('\n=========================================');
      console.log(`¡CLIENTE DE WHATSAPP CONECTADO COMO: ${whatsappStatus.user.name}!`);
      console.log('=========================================\n');
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

        // Extraer cuerpo del mensaje
        const body = msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption || '';

        if (!body) continue;

        // 1. Filtrado local por palabras clave comercial/pedido antes de procesar o loguear nada
        if (!isRealEstateRequest(body)) continue;

        // Obtener nombre del grupo (desde caché o fetching)
        let chatName = 'Chat Grupo';
        const cached = cachedGroups.find(g => g.id === from);
        if (cached) {
          chatName = cached.name;
        } else {
          try {
            const metadata = await sock.groupMetadata(from);
            chatName = metadata.subject || 'Chat Grupo';
            registerGroupFromMessage(from, chatName);
          } catch (e) {
            console.warn('[WHATSAPP] No se pudo obtener metadatos del grupo en upsert:', e);
          }
        }

        // Filtrar por grupos seleccionados dinámicamente en settings.json
        const settings = loadSettings();
        const isGroupSelected = settings.selectedGroups.some(groupId =>
          groupId === from ||
          groupId.toLowerCase() === chatName.toLowerCase()
        );

        if (!isGroupSelected) continue;
        // Obtener el remitente (con soporte robusto para participantAlt de Baileys)
        const participantJid = (key as any).participantAlt || key.participant || (msg as any).participant || '';
        
        let number = '';
        if (participantJid && !participantJid.endsWith('@lid')) {
          number = participantJid.split('@')[0];
        } else {
          // Extraer número del creador/identificador del grupo desde key.remoteJid (e.g. 5493814590816-1580358193@g.us)
          number = from.split('@')[0].split('-')[0];
        }
        
        const senderName = msg.pushName || number || 'Remitente Anónimo';
        const senderContact = `@${number} (${senderName})`;

        // LOG: Mostrar únicamente mensajes que son pedidos comerciales de interés
        console.log(`[WhatsApp - Pedido Comercial] De: ${senderName} | Chat: "${chatName}"`);
        console.log(` > Mensaje: "${body.substring(0, 120)}${body.length > 120 ? '...' : ''}"`);

        // Delegar al orquestador del pipeline
        await options.onMessage({ body }, senderContact, chatName, number);
      } catch (error) {
        console.error('Error al procesar mensaje entrante de WhatsApp:', error);
      }
    }
  });

  return sock;
}

/**
 * Limpia la configuración de grupos seleccionados y la caché en memoria y disco
 */
export function clearSessionLocalData(): void {
  cachedGroups = [];
  saveSettings({ selectedGroups: [] });
  try {
    if (fs.existsSync(GROUPS_CACHE_PATH)) {
      fs.unlinkSync(GROUPS_CACHE_PATH);
      console.log('[WHATSAPP] Caché de grupos eliminada de disco.');
    }
  } catch (e) {
    console.error('[WHATSAPP] Error al borrar archivo de caché de grupos:', e);
  }
}

/**
 * Destruye la sesión actual de WhatsApp, limpia archivos temporales y reinicia el cliente
 */
export async function restartWhatsAppClient(): Promise<void> {
  console.log('[WHATSAPP] Iniciando proceso de reinicio forzado...');

  if (sockInstance) {
    const oldSock = sockInstance;
    sockInstance = null; // Evitar que el handler 'close' intente reconectar
    try {
      oldSock.end(new Error('Reinicio manual solicitado'));
      console.log('[WHATSAPP] Instancia anterior finalizada.');
    } catch (error) {
      console.error('[WHATSAPP] Error al finalizar instancia de WhatsApp:', error);
    }
  }

  // Esperar un momento a que Windows libere los archivos
  await new Promise(resolve => setTimeout(resolve, 2000));

  const authDir = path.join(process.cwd(), '.baileys_auth');
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log('[WHATSAPP] Carpeta de sesión eliminada para forzar re-logueo.');
    } catch (err) {
      console.warn('[WHATSAPP] No se pudo borrar la carpeta de sesión (archivos bloqueados). Se continuará igualmente:', err);
    }
  }

  if (savedOptions) {
    await startWhatsAppClient(savedOptions);
  } else {
    console.error('[WHATSAPP] No se puede reiniciar: faltan opciones iniciales de configuración.');
  }
}

/**
 * Retorna todos los chats grupales del cliente actual
 */
export async function getActiveGroups(): Promise<{ id: string; name: string }[]> {
  if (whatsappStatus.status !== 'CONNECTED' || !sockInstance) {
    return cachedGroups;
  }

  try {
    console.log('[WHATSAPP] Recuperando lista de grupos en los que participa el cliente...');
    const groupsMetadata = await sockInstance.groupFetchAllParticipating();
    const groups = Object.keys(groupsMetadata).map(jid => ({
      id: jid,
      name: groupsMetadata[jid].subject || 'Grupo sin nombre'
    }));

    // Actualizar caché de grupos
    for (const group of groups) {
      if (!cachedGroups.some(g => g.id === group.id)) {
        cachedGroups.push(group);
      } else {
        // Actualizar el nombre si cambió
        const index = cachedGroups.findIndex(g => g.id === group.id);
        cachedGroups[index].name = group.name;
      }
    }
    saveGroupsCache();

    return groups;
  } catch (error) {
    console.error('[WHATSAPP] Error al obtener grupos de WhatsApp:', error);
    return cachedGroups;
  }
}
