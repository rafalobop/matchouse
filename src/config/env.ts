import * as dotenv from 'dotenv';
import * as path from 'path';

// Cargar variables de entorno desde .env
dotenv.config();

export interface Config {
  geminiApiKey: string;
  openaiApiKey?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseJwtSecret: string;
  supabaseAnonKey: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidEmail: string;
  appUrl: string;
  resendApiKey?: string;
  notificationChannel: 'whatsapp' | 'email';
  notificationIntervalMinutes: number;
  jiraDomain?: string;
  jiraEmail?: string;
  jiraProjectKey?: string;
  atlassianApiKey?: string;
  baileysFrozen: boolean;
  testWhatsappTenantIds: string[];
  sessionCleanupIntervalMinutes: number;
  devAlertEmail?: string;
  freeTextExtractionEnabled: boolean;
  searchExpirationIntervalMinutes: number;
}

function cleanEnvVar(val: string | undefined): string | undefined {
  if (!val) return val;
  return val.replace(/^["']|["']$/g, '').trim();
}

export function validateConfig(): Config {
  const geminiApiKey = cleanEnvVar(process.env.GEMINI_API_KEY);
  const openaiApiKey = cleanEnvVar(process.env.OPENAI_API_KEY);
  const supabaseUrl = cleanEnvVar(process.env.SUPABASE_URL);
  const supabaseServiceRoleKey = cleanEnvVar(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseJwtSecret = cleanEnvVar(process.env.SUPABASE_JWT_SECRET);
  const supabaseAnonKey = cleanEnvVar(process.env.SUPABASE_ANON_KEY);
  const vapidPublicKey = cleanEnvVar(process.env.VAPID_PUBLIC_KEY) || 'BNmVCR9MQPF4jTiJfcsqjZuVUpkc2eFjNviiA_ddqnZnbnzsJBRAdZ3PTfDK7OUIuVtbu4Oc8ANj_xpUy-_s0aI';
  const vapidPrivateKey = cleanEnvVar(process.env.VAPID_PRIVATE_KEY) || '8QmgGSOvRrSlm8Xi_dscW6bfaVjLNPiUsBndeXE8uQo';
  const vapidEmail = cleanEnvVar(process.env.VAPID_EMAIL) || 'mailto:info@housematch.com';
  const appUrl = cleanEnvVar(process.env.APP_URL) || 'http://localhost:3000';
  // SENDER_API_KEY es la API key de Resend (nombre histórico de la variable en .env)
  const resendApiKey = cleanEnvVar(process.env.SENDER_API_KEY);
  const notificationChannel = (cleanEnvVar(process.env.NOTIFICATION_CHANNEL) === 'whatsapp') ? 'whatsapp' : 'email';
  const notificationIntervalMinutes = parseInt(cleanEnvVar(process.env.NOTIFICATION_INTERVAL_MINUTES) || '20', 10);
  // Jira es solo para el grafo LangGraph de equipo de desarrollo (src/graph/), no para
  // la app de HouseMatch en sí — opcional a propósito, no debe romper el arranque del bot.
  const jiraDomain = cleanEnvVar(process.env.JIRA_DOMAIN);
  const jiraEmail = cleanEnvVar(process.env.JIRA_EMAIL);
  const jiraProjectKey = cleanEnvVar(process.env.JIRA_PROJECT_KEY);
  const atlassianApiKey = cleanEnvVar(process.env.ATLASSIAN_API_KEY);
  // KAN-32: congelamiento de Baileys — sin altas de cuentas de WhatsApp nuevas mientras
  // esta bandera esté activa. Default `true` (congelado) a propósito: el ticket que
  // introduce la bandera es el propio congelamiento; para descongelar hace falta setear
  // BAILEYS_FROZEN=false explícitamente en el entorno, nunca por omisión.
  const baileysFrozen = cleanEnvVar(process.env.BAILEYS_FROZEN) !== 'false';
  // KAN-53: lista explícita (allowlist) de tenant_id de cuentas de WhatsApp de prueba,
  // separados por coma. Deliberadamente explícita y no heurística: nunca debe desconectar
  // una sesión real por error. Vacía por default (`[]`) = el servicio de limpieza no hace nada.
  const testWhatsappTenantIds = (cleanEnvVar(process.env.TEST_WHATSAPP_TENANT_IDS) || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  // Frecuencia configurable del proceso de desconexión de sesiones de prueba (KAN-53).
  // Default 60 min: no son urgentes (no afectan a usuarios reales) y una cadencia
  // horaria evita logins/logouts innecesarios de Baileys sin dejar sesiones de prueba
  // colgadas por mucho tiempo.
  const sessionCleanupIntervalMinutes = parseInt(cleanEnvVar(process.env.SESSION_CLEANUP_INTERVAL_MINUTES) || '60', 10);
  // Email opcional de devs/testers al que avisar cuando se desconecta una sesión de prueba
  // (KAN-53). Si no está seteado, la notificación queda solo en los logs.
  const devAlertEmail = cleanEnvVar(process.env.DEV_ALERT_EMAIL);
  // KAN-36/KAN-38: extracción de texto libre de formulario (matching ciego), consumida por
  // POST /api/search. Habilitada por default desde KAN-38 (mismo patrón que BAILEYS_FROZEN):
  // hace falta FREE_TEXT_EXTRACTION_ENABLED=false explícito para apagarla. No afecta a
  // extractFromWhatsApp, que sigue funcionando siempre sin depender de este flag.
  const freeTextExtractionEnabled = cleanEnvVar(process.env.FREE_TEXT_EXTRACTION_ENABLED) !== 'false';
  // KAN-41: frecuencia del servicio en segundo plano que marca 'active_searches' vencidas
  // (expires_at < ahora) como 'expired'. Default 60 min: mismo criterio que
  // SESSION_CLEANUP_INTERVAL_MINUTES (KAN-53) - el vencimiento es a 7 días, no hace falta
  // chequear con más frecuencia que una vez por hora.
  const searchExpirationIntervalMinutes = parseInt(cleanEnvVar(process.env.SEARCH_EXPIRATION_INTERVAL_MINUTES) || '60', 10);

  if (!geminiApiKey) {
    throw new Error('Falta la variable de entorno GEMINI_API_KEY. Por favor, configúrala en el archivo .env.');
  }

  if (!supabaseJwtSecret) {
    throw new Error('Falta la variable de entorno SUPABASE_JWT_SECRET. Por favor, configúrala en el archivo .env.');
  }

  if (!supabaseAnonKey) {
    throw new Error('Falta la variable de entorno SUPABASE_ANON_KEY. Por favor, configúrala en el archivo .env.');
  }

  return {
    geminiApiKey,
    openaiApiKey,
    supabaseUrl,
    supabaseServiceRoleKey,
    supabaseJwtSecret,
    supabaseAnonKey,
    vapidPublicKey,
    vapidPrivateKey,
    vapidEmail,
    appUrl,
    resendApiKey,
    notificationChannel,
    notificationIntervalMinutes,
    jiraDomain,
    jiraEmail,
    jiraProjectKey,
    atlassianApiKey,
    baileysFrozen,
    testWhatsappTenantIds,
    sessionCleanupIntervalMinutes,
    devAlertEmail,
    freeTextExtractionEnabled,
    searchExpirationIntervalMinutes
  };
}

export const config = validateConfig();
