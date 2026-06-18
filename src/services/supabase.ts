import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env';
import ws from 'ws';
import jwt from 'jsonwebtoken';

if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
  console.warn('[SUPABASE] Las credenciales SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no están configuradas.');
}

export const supabase = createClient(
  config.supabaseUrl || '',
  config.supabaseServiceRoleKey || '',
  {
    auth: {
      persistSession: false
    },
    realtime: {
      transport: ws as any
    }
  }
);

/**
 * Genera un token JWT firmado con el secreto del proyecto para uso de RLS.
 */
export function generateTenantToken(tenantId: string, sessionToken: string): string {
  const payload = {
    role: 'authenticated',
    sub: tenantId,
    session_token: sessionToken,
    iss: 'supabase',
    aud: 'authenticated'
  };
  return jwt.sign(payload, config.supabaseJwtSecret, { expiresIn: '7d' });
}

/**
 * Retorna un cliente de Supabase configurado con la clave Anon y el JWT del Tenant.
 * Esto obliga a PostgREST a aplicar RLS en base al tenant.
 */
export function getTenantClient(token: string) {
  return createClient(
    config.supabaseUrl || '',
    config.supabaseAnonKey || '',
    {
      auth: {
        persistSession: false
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    }
  );
}
