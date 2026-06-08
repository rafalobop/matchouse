import { Client, LocalAuth, Message } from 'whatsapp-web.js';
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

let clientInstance: Client | null = null;
let savedOptions: WhatsAppClientOptions | null = null;

export interface WhatsAppClientOptions {
  onMessage: (message: Message, senderName: string, groupName: string) => Promise<void>;
}

export function startWhatsAppClient(options: WhatsAppClientOptions): Client {
  console.log('Iniciando cliente de WhatsApp Web...');
  whatsappStatus.status = 'INITIALIZING';
  whatsappStatus.syncPercentage = 0;
  whatsappStatus.syncMessage = 'Inicializando...';
  savedOptions = options;

  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
    }
  });

  clientInstance = client;

  client.on('loading_screen', (percent, message) => {
    whatsappStatus.status = 'AUTHENTICATED';
    whatsappStatus.syncPercentage = typeof percent === 'string' ? parseFloat(percent) : percent;
    whatsappStatus.syncMessage = message;
    console.log(`[WHATSAPP SYNC] Sincronización en curso: ${percent}% - ${message}`);
  });

  // Generación de código QR
  client.on('qr', async (qr) => {
    whatsappStatus.status = 'QR_RECEIVED';
    console.log('\n=========================================');
    console.log('ESCANEÁ EL CÓDIGO QR CON WHATSAPP PARA LOGUEARTE:');
    console.log('=========================================\n');
    qrcodeTerminal.generate(qr, { small: true });

    try {
      // Convertir el QR a Data URL para mostrarlo en el navegador
      whatsappStatus.qrDataUrl = await QRCode.toDataURL(qr);
    } catch (err) {
      console.error('Error al generar QR DataURL:', err);
    }
  });

  // Autenticación exitosa
  client.on('authenticated', () => {
    whatsappStatus.status = 'AUTHENTICATED';
    console.log('Autenticación exitosa con WhatsApp Web.');
  });

  // Falla de autenticación
  client.on('auth_failure', (msg) => {
    whatsappStatus.status = 'DISCONNECTED';
    console.error('Fallo en la autenticación de WhatsApp:', msg);
  });

  // Cliente listo
  client.on('ready', () => {
    whatsappStatus.status = 'CONNECTED';
    whatsappStatus.qrDataUrl = undefined;
    
    const info = client.info;
    whatsappStatus.user = {
      name: info.pushname || 'Usuario',
      number: info.wid.user
    };

    console.log('\n=========================================');
    console.log(`¡CLIENTE DE WHATSAPP CONECTADO COMO: ${whatsappStatus.user.name}!`);
    console.log('=========================================\n');
  });

  // Desconexión
  client.on('disconnected', (reason) => {
    whatsappStatus.status = 'DISCONNECTED';
    whatsappStatus.user = undefined;
    console.log('Cliente de WhatsApp desconectado:', reason);
  });

  // Escuchar mensajes entrantes
  client.on('message', async (message) => {
    try {
      // 1. Filtrado local por palabras clave comercial/pedido antes de procesar o loguear nada
      if (!isRealEstateRequest(message.body)) {
        return;
      }

      const chat = await message.getChat();
      const chatName = chat.name || 'Chat Individual';
      const isGroup = message.from.endsWith('@g.us');

      // Solo procesar mensajes de grupos
      if (!isGroup) {
        return;
      }

      // Filtrar por grupos seleccionados dinámicamente en settings.json
      const settings = loadSettings();
      const isGroupSelected = settings.selectedGroups.some(groupId => 
        groupId === chat.id._serialized || 
        groupId.toLowerCase() === chatName.toLowerCase()
      );

      if (!isGroupSelected) {
        return;
      }

      // Obtener el remitente
      const contact = await message.getContact();
      const senderName = contact.pushname || contact.number || 'Remitente Anónimo';
      const senderContact = `@${contact.number} (${senderName})`;

      // LOG: Mostrar únicamente mensajes que son pedidos comerciales de interés
      console.log(`[WhatsApp - Pedido Comercial] De: ${senderName} | Chat: "${chatName}"`);
      console.log(` > Mensaje: "${message.body.substring(0, 120)}${message.body.length > 120 ? '...' : ''}"`);

      // Delegar al orquestador del pipeline
      await options.onMessage(message, senderContact, chatName);
    } catch (error) {
      console.error('Error al procesar mensaje entrante de WhatsApp:', error);
    }
  });

  client.initialize().catch((err) => {
    whatsappStatus.status = 'DISCONNECTED';
    console.error('Error al inicializar el cliente de WhatsApp:', err);
  });

  return client;
}

/**
 * Destruye la sesión actual de WhatsApp, limpia archivos temporales y reinicia el cliente
 */
export async function restartWhatsAppClient(): Promise<void> {
  console.log('[WHATSAPP] Iniciando proceso de reinicio forzado...');
  
  if (clientInstance) {
    try {
      await clientInstance.destroy();
      console.log('[WHATSAPP] Instancia anterior destruida con éxito.');
    } catch (error) {
      console.error('[WHATSAPP] Error al destruir instancia de WhatsApp:', error);
    }
    clientInstance = null;
  }

  // Esperar un momento a que Windows libere los archivos
  await new Promise(resolve => setTimeout(resolve, 2000));

  const authDir = path.join(process.cwd(), '.wwebjs_auth');
  if (fs.existsSync(authDir)) {
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log('[WHATSAPP] Carpeta de sesión eliminada para forzar re-logueo.');
    } catch (err) {
      console.warn('[WHATSAPP] No se pudo borrar la carpeta de sesión (archivos bloqueados). Se continuará igualmente:', err);
    }
  }

  if (savedOptions) {
    startWhatsAppClient(savedOptions);
  } else {
    console.error('[WHATSAPP] No se puede reiniciar: faltan opciones iniciales de configuración.');
  }
}

/**
 * Retorna todos los chats grupales del cliente actual
 */
export async function getActiveGroups(): Promise<{ id: string; name: string }[]> {
  if (whatsappStatus.status !== 'CONNECTED' || !clientInstance) {
    return [];
  }
  try {
    const chats = await clientInstance.getChats();
    return chats
      .filter(chat => chat.isGroup)
      .map(chat => ({
        id: chat.id._serialized,
        name: chat.name || 'Grupo sin nombre'
      }));
  } catch (error) {
    console.error('Error al obtener grupos de WhatsApp:', error);
    return [];
  }
}
