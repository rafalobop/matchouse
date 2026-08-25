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
  resendApiKey: string;
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
  adminHost?: string;
  adminAppUrl?: string;
  metricsRateLimitMax: number;
  metricsRateLimitWindowMs: number;
  excelParsePoolSize: number;
  excelParseTimeoutMs: number;
  /** KAN-122: nombres de las variables de Supabase que faltan (vacío si están todas presentes). */
  missingSupabaseCredentials: string[];
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
  // Panel admin (app.admin.brokaza.com): mismo proceso Express que el resto de la app, pero
  // solo se sirve el adminRouter cuando el Host de la request coincide con esta variable. Sin
  // ADMIN_HOST seteada, el panel admin queda completamente deshabilitado (útil en local/dev).
  const adminHost = cleanEnvVar(process.env.ADMIN_HOST);
  // URL a la que redirige el magic link del panel admin. Opcional: si no se setea, se arma como
  // `https://${ADMIN_HOST}` (correcto en producción, donde el dominio admin tiene TLS real — sea
  // un custom domain o el dominio *.up.railway.app que Railway da gratis). En local, sin dominio
  // propio ni certificado, hace falta setearla explícita a algo como http://localhost:3000 para
  // poder probar el flujo de login completo en el navegador.
  const adminAppUrl = cleanEnvVar(process.env.ADMIN_APP_URL);
  // KAN-131: GET /api/metrics es autenticado (adminAuthMiddleware), pero eso solo prueba
  // identidad — no evita que una sesión admin válida (o su cookie robada/filtrada) haga polling
  // agresivo y dispare Promise.all con 4 counts contra Postgres en cada request. Mismo criterio
  // que search/upload (KAN-71): rate limit por identidad estable (adminUserId), no por IP, porque
  // el endpoint ya está detrás de auth. El dashboard admin pollea cada 7s (~8.6 req/min) — 30/min
  // da margen para varias pestañas/instancias del mismo admin sin abrir la puerta a scraping.
  const metricsRateLimitMax = parseInt(cleanEnvVar(process.env.METRICS_RATE_LIMIT_MAX) || '30', 10);
  const metricsRateLimitWindowMs = parseInt(cleanEnvVar(process.env.METRICS_RATE_LIMIT_WINDOW_MS) || '60000', 10);
  // KAN-137: cantidad de worker threads persistentes que parsean Excels subidos (xlsx.read +
  // resolución de columnas, ver excelParsePool.ts) sin bloquear el event loop del proceso
  // principal. Default 2: la instancia real de Railway tiene 2 vCPU / 1GB de RAM compartidos con
  // el resto del proceso (WS hub, notifier-email, search expiration, etc.) — un pool sin límite
  // podría agotar CPU/RAM ante uploads concurrentes de varios tenants.
  const excelParsePoolSize = parseInt(cleanEnvVar(process.env.EXCEL_PARSE_POOL_SIZE) || '2', 10);
  // Límite de tiempo por tarea de parseo en el worker — protege contra un archivo malformado (o
  // un bug de xlsx) que deje un worker colgado indefinidamente, sacando ese slot del pool para
  // siempre. 30s es generoso para un Excel de hasta uploadMaxFileSizeBytes (10MB default).
  const excelParseTimeoutMs = parseInt(cleanEnvVar(process.env.EXCEL_PARSE_TIMEOUT_MS) || '30000', 10);

  // KAN-122: sin SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY la app queda inservible (todo el acceso a
  // datos pasa por el cliente service-role de src/services/supabase.ts) — antes de este ticket
  // arrancaba igual con un console.warn, y cada request recién fallaba en el primer intento real
  // de pegarle a Supabase. Por default el arranque se aborta acá mismo, con un mensaje que lista
  // exactamente qué variable falta. ALLOW_MISSING_SUPABASE_CREDENTIALS=true permite arrancar
  // igual (solo pensado para desarrollo local sin Supabase todavía configurado) — hace falta
  // habilitarlo explícito, no alcanza con NODE_ENV=development.
  const allowMissingSupabaseCredentials = cleanEnvVar(process.env.ALLOW_MISSING_SUPABASE_CREDENTIALS) === 'true';
  const missingSupabaseCredentials: string[] = [];
  if (!supabaseUrl) missingSupabaseCredentials.push('SUPABASE_URL');
  if (!supabaseServiceRoleKey) missingSupabaseCredentials.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missingSupabaseCredentials.length > 0 && !allowMissingSupabaseCredentials) {
    throw new Error(
      `Faltan las siguientes variables de entorno de Supabase: ${missingSupabaseCredentials.join(', ')}. ` +
      'Configuralas en el archivo .env, o seteá ALLOW_MISSING_SUPABASE_CREDENTIALS=true para arrancar ' +
      'igual en modo desarrollo (la app va a mostrar un aviso, pero cualquier función que dependa de ' +
      'Supabase va a fallar).'
    );
  }
  if (missingSupabaseCredentials.length > 0) {
    console.warn(
      `[CONFIG] Arrancando con credenciales de Supabase incompletas (${missingSupabaseCredentials.join(', ')}) ` +
      'porque ALLOW_MISSING_SUPABASE_CREDENTIALS=true. Esto NO debe estar habilitado en producción.'
    );
  }

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

  // 2026-08-22: SENDER_API_KEY (Resend) pasa de opcional a fail-fast — hasta ahora solo
  // alimentaba el aviso de "interesados" (canal secundario, se degradaba en silencio si faltaba).
  // Desde que el magic link ya no lo manda Supabase (KAN-269, `sendMagicLinkEmail`/
  // `sendAdminMagicLinkEmail` en notifier-email.ts), es la única forma de iniciar sesión —
  // arrancar sin esto dejaría a todo el mundo (tenant y admin) sin poder loguearse, con un error
  // genérico de "no pudimos enviar el email" en vez de una falla clara al arrancar.
  if (!resendApiKey) {
    throw new Error('Falta la variable de entorno SENDER_API_KEY (Resend). Por favor, configúrala en el archivo .env.');
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
    internalWebhookSecret,
    adminHost,
    adminAppUrl,
    metricsRateLimitMax,
    metricsRateLimitWindowMs,
    excelParsePoolSize,
    excelParseTimeoutMs,
    missingSupabaseCredentials
  };
}

export const config = validateConfig();
