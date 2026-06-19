import * as dotenv from 'dotenv';
import * as path from 'path';

// Cargar variables de entorno desde .env
dotenv.config();

export interface Config {
  geminiApiKey: string;
  openaiApiKey?: string;
  googleSheetId: string;
  googleCarteraTabName: string;
  googleMatchesTabName: string;
  whatsappGroupName?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseJwtSecret: string;
  supabaseAnonKey: string;
}

function cleanEnvVar(val: string | undefined): string | undefined {
  if (!val) return val;
  return val.replace(/^["']|["']$/g, '').trim();
}

export function validateConfig(): Config {
  const geminiApiKey = cleanEnvVar(process.env.GEMINI_API_KEY);
  const openaiApiKey = cleanEnvVar(process.env.OPENAI_API_KEY);
  const googleSheetId = cleanEnvVar(process.env.GOOGLE_SHEET_ID);
  const googleCarteraTabName = cleanEnvVar(process.env.GOOGLE_CARTERA_TAB_NAME) || 'Cartera';
  const googleMatchesTabName = cleanEnvVar(process.env.GOOGLE_MATCHES_TAB_NAME) || '[MATCHES ENCONTRADOS]';
  const whatsappGroupName = cleanEnvVar(process.env.WHATSAPP_GROUP_NAME);
  const supabaseUrl = cleanEnvVar(process.env.SUPABASE_URL);
  const supabaseServiceRoleKey = cleanEnvVar(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseJwtSecret = cleanEnvVar(process.env.SUPABASE_JWT_SECRET);
  const supabaseAnonKey = cleanEnvVar(process.env.SUPABASE_ANON_KEY);

  if (!geminiApiKey) {
    throw new Error('Falta la variable de entorno GEMINI_API_KEY. Por favor, configúrala en el archivo .env.');
  }

  if (!googleSheetId) {
    throw new Error('Falta la variable de entorno GOOGLE_SHEET_ID. Por favor, configúrala en el archivo .env.');
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
    googleSheetId,
    googleCarteraTabName,
    googleMatchesTabName,
    whatsappGroupName,
    supabaseUrl,
    supabaseServiceRoleKey,
    supabaseJwtSecret,
    supabaseAnonKey,
  };
}

export const config = validateConfig();
