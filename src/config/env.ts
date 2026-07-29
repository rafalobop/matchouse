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
  notificationIntervalMinutes: number;
  jiraDomain?: string;
  jiraEmail?: string;
  jiraProjectKey?: string;
  atlassianApiKey?: string;
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
  const notificationIntervalMinutes = parseInt(cleanEnvVar(process.env.NOTIFICATION_INTERVAL_MINUTES) || '20', 10);
  // Jira es solo para el grafo LangGraph de equipo de desarrollo (src/graph/), no para
  // la app de HouseMatch en sí — opcional a propósito, no debe romper el arranque del bot.
  const jiraDomain = cleanEnvVar(process.env.JIRA_DOMAIN);
  const jiraEmail = cleanEnvVar(process.env.JIRA_EMAIL);
  const jiraProjectKey = cleanEnvVar(process.env.JIRA_PROJECT_KEY);
  const atlassianApiKey = cleanEnvVar(process.env.ATLASSIAN_API_KEY);
  // KAN-36/KAN-38: extracción de texto libre de formulario (matching ciego), consumida por
  // POST /api/search. Habilitada por default desde KAN-38: hace falta
  // FREE_TEXT_EXTRACTION_ENABLED=false explícito para apagarla. No afecta a
  // extractFromWhatsApp, que sigue funcionando siempre sin depender de este flag.
  const freeTextExtractionEnabled = cleanEnvVar(process.env.FREE_TEXT_EXTRACTION_ENABLED) !== 'false';
  // KAN-41: frecuencia del servicio en segundo plano que marca 'active_searches' vencidas
  // (expires_at < ahora) como 'expired'. Default 60 min: el vencimiento es a 7 días, no hace
  // falta chequear con más frecuencia que una vez por hora.
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
    notificationIntervalMinutes,
    jiraDomain,
    jiraEmail,
    jiraProjectKey,
    atlassianApiKey,
    freeTextExtractionEnabled,
    searchExpirationIntervalMinutes
  };
}

export const config = validateConfig();
