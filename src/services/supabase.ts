import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/env';
import ws from 'ws';
import jwt from 'jsonwebtoken';

// KAN-122: la validación real (fail-fast salvo ALLOW_MISSING_SUPABASE_CREDENTIALS=true) vive en
// src/config/env.ts#validateConfig. Fix QA (2026-08-14): `createClient('', ...)` no es un cliente
// "roto pero utilizable" como asumía la versión anterior de este comentario — el SDK de Supabase
// valida `supabaseUrl` en el constructor de `SupabaseClient` y tira una excepción SÍNCRONA no
// capturada si está vacío. Como este módulo se importa en cadena desde `src/index.ts` al arrancar
// (antes de que Express levante el puerto), esa excepción mataba el proceso incluso con
// ALLOW_MISSING_SUPABASE_CREDENTIALS=true habilitado — el server nunca llegaba a escuchar, así
// que el modal de "Configuración incompleta" del dashboard (que depende de que el server esté
// arriba para servirlo) era inalcanzable en la práctica.
// Fix: si faltan credenciales, `supabase` es un Proxy que solo tira al primer uso real (cualquier
// función que dependa de la base sigue fallando, como debe ser), no al importar el módulo — el
// arranque del servidor no depende de que Supabase esté configurado.
function createMissingCredentialsStub(): SupabaseClient {
  return new Proxy({}, {
    get(): never {
      throw new Error(
        `No se puede usar Supabase: faltan las credenciales ${config.missingSupabaseCredentials.join(', ')}. ` +
        'Configuralas en el archivo .env.'
      );
    }
  }) as unknown as SupabaseClient;
}

export const supabase: SupabaseClient = config.missingSupabaseCredentials.length > 0
  ? createMissingCredentialsStub()
  : createClient(
      config.supabaseUrl!,
      config.supabaseServiceRoleKey!,
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

// Caché de clientes Supabase por token de Tenant para evitar fugas de memoria
const tenantClientsCache = new Map<string, SupabaseClient>();

/**
 * Retorna un cliente de Supabase configurado con la clave Anon y el JWT del Tenant.
 * Esto obliga a PostgREST a aplicar RLS en base al tenant.
 */
export function getTenantClient(token: string): SupabaseClient {
  let client = tenantClientsCache.get(token);
  if (!client) {
    client = createClient(
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
        },
        realtime: {
          transport: ws as any
        }
      }
    );
    tenantClientsCache.set(token, client);
  }
  return client;
}
