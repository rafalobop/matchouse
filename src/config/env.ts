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
  aiRequestTimeoutMs: number;
  searchRateLimitMax: number;
  searchRateLimitWindowMs: number;
  uploadRateLimitMax: number;
  uploadRateLimitWindowMs: number;
  uploadMaxFileSizeBytes: number;
  internalWebhookSecret: string;
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
  const vapidPublicKey = cleanEnvVar(process.env.VAPID_PUBLIC_KEY);
  const vapidPrivateKey = cleanEnvVar(process.env.VAPID_PRIVATE_KEY);
  const vapidEmail = cleanEnvVar(process.env.VAPID_EMAIL) || 'mailto:info@brokaza.com';
  const appUrl = cleanEnvVar(process.env.APP_URL) || 'http://localhost:3000';
  // SENDER_API_KEY es la API key de Resend (nombre histórico de la variable en .env)
  const resendApiKey = cleanEnvVar(process.env.SENDER_API_KEY);
  const notificationIntervalMinutes = parseInt(cleanEnvVar(process.env.NOTIFICATION_INTERVAL_MINUTES) || '20', 10);
  // Jira es solo para el grafo LangGraph de equipo de desarrollo (src/graph/), no para
  // la app de Brokaza en sí — opcional a propósito, no debe romper el arranque del bot.
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
  // KAN-70: límite de tiempo para cada llamada individual a generateContent/chat.completions.create
  // en ai.ts. Default 20s: POST /api/search es un camino síncrono de un request HTTP (el usuario
  // espera la respuesta en el dashboard), así que no puede quedar colgado indefinidamente si el
  // proveedor de IA no responde.
  const aiRequestTimeoutMs = parseInt(cleanEnvVar(process.env.AI_REQUEST_TIMEOUT_MS) || '20000', 10);
  // KAN-71: POST /api/search y POST /api/upload ya están detrás de tenantAuthMiddleware, pero
  // eso no los protege de un tenant legítimo (o su token robado/filtrado) haciendo un uso
  // abusivo — /api/search dispara llamadas pagas a Gemini/OpenAI por request, /api/upload hace
  // un diff completo contra `properties`. Rate limit por tenantId (no por IP, a diferencia del
  // limiter de /api/auth/*): son endpoints ya autenticados, así que la identidad real y estable
  // es el tenant, no la IP (que puede ser compartida en una oficina o rotar).
  // Búsqueda: uso normal es de a una por vez desde el formulario; 10/min dan margen amplio sin
  // habilitar un loop de scraping.
  const searchRateLimitMax = parseInt(cleanEnvVar(process.env.SEARCH_RATE_LIMIT_MAX) || '10', 10);
  const searchRateLimitWindowMs = parseInt(cleanEnvVar(process.env.SEARCH_RATE_LIMIT_WINDOW_MS) || '60000', 10);
  // Upload: cargar el catálogo completo es una acción administrativa poco frecuente (se sube el
  // Excel entero de la cartera) — mismo cupo que el limiter de auth existente (5/min) por ser
  // igual de infrecuente en tráfico legítimo.
  const uploadRateLimitMax = parseInt(cleanEnvVar(process.env.UPLOAD_RATE_LIMIT_MAX) || '5', 10);
  const uploadRateLimitWindowMs = parseInt(cleanEnvVar(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS) || '60000', 10);
  // Límite de tamaño del archivo Excel subido (mitigación DoS complementaria al rate limit: sin
  // esto, multer.memoryStorage() acepta un archivo de cualquier tamaño en memoria del proceso).
  // 10MB es generoso para un Excel de cartera de propiedades (formato de texto/celdas, no medios).
  const uploadMaxFileSizeBytes = parseInt(cleanEnvVar(process.env.UPLOAD_MAX_FILE_SIZE_BYTES) || String(10 * 1024 * 1024), 10);
  // KAN-79: secreto compartido de POST /internal/property-match-check — sin sesión de usuario (lo
  // llama el trigger de Postgres vía pg_net, no un tenant), así que sin este secreto el endpoint
  // quedaría abierto a cualquiera que adivine la URL. El mismo valor debe estar guardado en
  // Supabase Vault (secret 'internal_webhook_secret'), leído por la función del trigger.
  const internalWebhookSecret = cleanEnvVar(process.env.INTERNAL_WEBHOOK_SECRET);

  if (!geminiApiKey) {
    throw new Error('Falta la variable de entorno GEMINI_API_KEY. Por favor, configúrala en el archivo .env.');
  }

  if (!supabaseJwtSecret) {
    throw new Error('Falta la variable de entorno SUPABASE_JWT_SECRET. Por favor, configúrala en el archivo .env.');
  }

  if (!supabaseAnonKey) {
    throw new Error('Falta la variable de entorno SUPABASE_ANON_KEY. Por favor, configúrala en el archivo .env.');
  }

  if (!internalWebhookSecret) {
    throw new Error('Falta la variable de entorno INTERNAL_WEBHOOK_SECRET. Por favor, configúrala en el archivo .env.');
  }

  if (!vapidPublicKey) {
    throw new Error('Falta la variable de entorno VAPID_PUBLIC_KEY. Por favor, configúrala en el archivo .env.');
  }

  if (!vapidPrivateKey) {
    throw new Error('Falta la variable de entorno VAPID_PRIVATE_KEY. Por favor, configúrala en el archivo .env.');
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
    searchExpirationIntervalMinutes,
    aiRequestTimeoutMs,
    searchRateLimitMax,
    searchRateLimitWindowMs,
    uploadRateLimitMax,
    uploadRateLimitWindowMs,
    uploadMaxFileSizeBytes,
    internalWebhookSecret
  };
}

export const config = validateConfig();
