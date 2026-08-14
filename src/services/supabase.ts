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

// KAN-123: caché de clientes Supabase por token de Tenant, con TTL — el comentario original de
// esta caché ("para evitar fugas de memoria") no se sostenía en la práctica: un token que pasa
// una sola vez por acá (login, o una sesión que nunca vuelve a pollear) quedaba en el Map para
// siempre, sin importar que el token real expire a los 7 días (ver generateTenantToken). Con
// tráfico real y logins repetidos, el proceso crecía sin límite hasta el próximo reinicio.
interface TenantClientCacheEntry {
  client: SupabaseClient;
  expiresAt: number;
}

export const TENANT_CLIENT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos
const TENANT_CLIENT_CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

const tenantClientsCache = new Map<string, TenantClientCacheEntry>();

/**
 * Retorna un cliente de Supabase configurado con la clave Anon y el JWT del Tenant.
 * Esto obliga a PostgREST a aplicar RLS en base al tenant.
 */
export function getTenantClient(token: string): SupabaseClient {
  const cached = tenantClientsCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.client;
  }

  // Lectura + escritura sincrónicas dentro del mismo tick de JS: no hay ninguna operación async
  // en el medio que permita que dos llamadas concurrentes con el mismo token pisen entradas entre
  // sí (nada de condiciones de carrera posibles acá, a diferencia de un cache respaldado por I/O).
  const client = createClient(
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
  tenantClientsCache.set(token, { client, expiresAt: Date.now() + TENANT_CLIENT_CACHE_TTL_MS });
  return client;
}

/**
 * Purga las entradas vencidas de `tenantClientsCache`. `getTenantClient` ya invalida por su
 * cuenta una entrada vencida cuando ese mismo token vuelve a pedirse, pero eso no alcanza para
 * tokens que nunca vuelven (logout, pestaña cerrada) — sin este barrido, esos siguen ocupando
 * memoria hasta el reinicio del proceso. Costo acotado: recorre el Map una vez cada 5 minutos,
 * nunca bajo tráfico real de request (no compite por el event loop de ninguna request en curso).
 */
function sweepExpiredTenantClients(): void {
  const now = Date.now();
  for (const [token, entry] of tenantClientsCache) {
    if (entry.expiresAt <= now) {
      tenantClientsCache.delete(token);
    }
  }
}

// .unref() para que este timer no mantenga vivo el proceso por sí solo (ej. en tests, que no
// llaman a main() ni levantan el servidor pero sí importan este módulo).
setInterval(sweepExpiredTenantClients, TENANT_CLIENT_CACHE_SWEEP_INTERVAL_MS).unref();

/** Solo para tests: tamaño actual de la caché, sin exponer las instancias de cliente. */
export function __getTenantClientCacheSizeForTests(): number {
  return tenantClientsCache.size;
}

/** Solo para tests: fuerza a que la entrada de `token` quede vencida, sin esperar el TTL real. */
export function __expireTenantClientForTests(token: string): void {
  const entry = tenantClientsCache.get(token);
  if (entry) entry.expiresAt = Date.now() - 1;
}

/** Solo para tests: corre el barrido de entradas vencidas fuera del setInterval real. */
export function __sweepTenantClientsCacheForTests(): void {
  sweepExpiredTenantClients();
}
