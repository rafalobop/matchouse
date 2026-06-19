import test from 'node:test';
import assert from 'node:assert';
import { generateTenantToken, getTenantClient } from '../src/services/supabase';

test('Supabase Service - Debería exportar funciones de generación de JWT y cliente', () => {
  assert.strictEqual(typeof generateTenantToken, 'function', 'generateTenantToken debe ser una función.');
  assert.strictEqual(typeof getTenantClient, 'function', 'getTenantClient debe ser una función.');
});
