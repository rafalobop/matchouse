import test from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import {
  generateTenantToken,
  getTenantClient,
  supabase,
  TENANT_CLIENT_CACHE_TTL_MS,
  TypedSupabaseClient,
  __getTenantClientCacheSizeForTests,
  __expireTenantClientForTests,
  __sweepTenantClientsCacheForTests
} from '../src/services/supabase';
import { config } from '../src/config/env';

// KAN-139: guard de compilación (nunca se invoca en runtime) — si alguien rompe el wiring de
// `TypedSupabaseClient`/`Database` (ej. cambia `supabase.ts` para volver a un cliente sin tipar),
// esta función deja de tipar y `tsc --noEmit` falla acá, sin depender de que un test en runtime
// lo detecte (los tipos se borran al compilar, no hay forma de "assertear" esto con node:test).
function _typeCheckOnly_typedSupabaseClientSelectsRealColumns(client: TypedSupabaseClient) {
  return client.from('properties').select('address, price, tenant_id');
}
void _typeCheckOnly_typedSupabaseClientSelectsRealColumns;

test('Supabase Service - Debería exportar funciones de generación de JWT y cliente', () => {
  assert.strictEqual(typeof generateTenantToken, 'function', 'generateTenantToken debe ser una función.');
  assert.strictEqual(typeof getTenantClient, 'function', 'getTenantClient debe ser una función.');
});

test('Supabase Service (KAN-139) - supabase/getTenantClient siguen exponiendo la API real del SDK (from/select) tras tipar con Database', () => {
  assert.strictEqual(typeof supabase.from, 'function', 'El cliente tipado debe seguir exponiendo .from() en runtime (los tipos no cambian el JS emitido).');
  const token = generateTenantToken('77777777-7777-7777-7777-777777777777', 'session-typed');
  const tenantClient = getTenantClient(token);
  assert.strictEqual(typeof tenantClient.from, 'function');
});

test('Supabase Service - generateTenantToken (KAN-63) firma un JWT válido para RLS con role=authenticated y sub=tenantId', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const token = generateTenantToken(tenantId, 'test-session-token');
  const decoded: any = jwt.verify(token, config.supabaseJwtSecret);

  assert.strictEqual(decoded.sub, tenantId, 'El claim "sub" debe ser el tenantId (lo que auth.uid() lee en las policies de RLS).');
  assert.strictEqual(decoded.role, 'authenticated', 'El claim "role" debe ser "authenticated" para que RLS trate al cliente como logueado.');
  assert.strictEqual(decoded.aud, 'authenticated');
});

test('Supabase Service - getTenantClient (KAN-63, patrón Tenant Context) cachea por token y crea clientes distintos para tenants distintos', () => {
  const tokenA = generateTenantToken('22222222-2222-2222-2222-222222222222', 'session-a');
  const tokenB = generateTenantToken('33333333-3333-3333-3333-333333333333', 'session-b');

  const clientA1 = getTenantClient(tokenA);
  const clientA2 = getTenantClient(tokenA);
  const clientB = getTenantClient(tokenB);

  assert.strictEqual(clientA1, clientA2, 'El mismo token debe reutilizar la misma instancia de cliente cacheada (evita fugas de memoria).');
  assert.notStrictEqual(clientA1, clientB, 'Tokens de tenants distintos deben producir instancias de cliente distintas (aislamiento).');
});

test('Supabase Service - getTenantClient (KAN-123) el TTL de la caché es de 30 minutos', () => {
  assert.strictEqual(TENANT_CLIENT_CACHE_TTL_MS, 30 * 60 * 1000, 'El TTL de tenantClientsCache debe ser 30 minutos, según lo pedido por KAN-123.');
});

test('Supabase Service - getTenantClient (KAN-123) una entrada vencida se recrea en vez de reutilizarse', () => {
  const token = generateTenantToken('44444444-4444-4444-4444-444444444444', 'session-ttl');

  const client1 = getTenantClient(token);
  __expireTenantClientForTests(token);
  const client2 = getTenantClient(token);

  assert.notStrictEqual(client1, client2, 'Una entrada vencida (expiresAt en el pasado) no debe reutilizarse — getTenantClient debe crear un cliente nuevo.');
});

test('Supabase Service - getTenantClient (KAN-123) el barrido periódico purga entradas vencidas sin esperar a que se vuelvan a pedir', () => {
  const token = generateTenantToken('55555555-5555-5555-5555-555555555555', 'session-sweep');

  getTenantClient(token);
  const sizeBeforeExpiry = __getTenantClientCacheSizeForTests();
  assert.ok(sizeBeforeExpiry > 0, 'La caché debe tener al menos una entrada después de getTenantClient.');

  __expireTenantClientForTests(token);
  __sweepTenantClientsCacheForTests();

  const sizeAfterSweep = __getTenantClientCacheSizeForTests();
  assert.strictEqual(sizeAfterSweep, sizeBeforeExpiry - 1, 'El barrido debe eliminar la entrada vencida sin que nadie vuelva a pedir ese token (evita la fuga de memoria original de KAN-123).');
});

test('Supabase Service - getTenantClient (KAN-123) el barrido no rompe con la caché vacía ni con entradas todavía vigentes', () => {
  const token = generateTenantToken('66666666-6666-6666-6666-666666666666', 'session-vigente');
  const client = getTenantClient(token);

  assert.doesNotThrow(() => __sweepTenantClientsCacheForTests(), 'El barrido no debe lanzar excepciones.');
  assert.strictEqual(getTenantClient(token), client, 'Una entrada todavía vigente (no vencida) no debe purgarse por el barrido.');
});
