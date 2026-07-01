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
    appUrl
  };
}

export const config = validateConfig();
