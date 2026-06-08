import * as dotenv from 'dotenv';
import * as path from 'path';

// Cargar variables de entorno desde .env
dotenv.config();

export interface Config {
  geminiApiKey: string;
  googleSheetId: string;
  googleCarteraTabName: string;
  googleMatchesTabName: string;
  whatsappGroupName?: string;
}

function cleanEnvVar(val: string | undefined): string | undefined {
  if (!val) return val;
  return val.replace(/^["']|["']$/g, '').trim();
}

export function validateConfig(): Config {
  const geminiApiKey = cleanEnvVar(process.env.GEMINI_API_KEY);
  const googleSheetId = cleanEnvVar(process.env.GOOGLE_SHEET_ID);
  const googleCarteraTabName = cleanEnvVar(process.env.GOOGLE_CARTERA_TAB_NAME) || 'Cartera';
  const googleMatchesTabName = cleanEnvVar(process.env.GOOGLE_MATCHES_TAB_NAME) || '[MATCHES ENCONTRADOS]';
  const whatsappGroupName = cleanEnvVar(process.env.WHATSAPP_GROUP_NAME);

  if (!geminiApiKey) {
    throw new Error('Falta la variable de entorno GEMINI_API_KEY. Por favor, configúrala en el archivo .env.');
  }

  if (!googleSheetId) {
    throw new Error('Falta la variable de entorno GOOGLE_SHEET_ID. Por favor, configúrala en el archivo .env.');
  }

  return {
    geminiApiKey,
    googleSheetId,
    googleCarteraTabName,
    googleMatchesTabName,
    whatsappGroupName,
  };
}

export const config = validateConfig();
