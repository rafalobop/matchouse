import test from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { generateTenantToken, getTenantClient } from '../src/services/supabase';
import { config } from '../src/config/env';

test('Supabase Service - Debería exportar funciones de generación de JWT y cliente', () => {
  assert.strictEqual(typeof generateTenantToken, 'function', 'generateTenantToken debe ser una función.');
  assert.strictEqual(typeof getTenantClient, 'function', 'getTenantClient debe ser una función.');
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
