import test from 'node:test';
import assert from 'node:assert';
import { useSupabaseAuthState, clearSupabaseSession } from '../src/services/supabaseAuth';

test('Supabase Auth Service - Debería exportar funciones para auth de Baileys', () => {
  assert.strictEqual(typeof useSupabaseAuthState, 'function', 'useSupabaseAuthState debe ser una función.');
  assert.strictEqual(typeof clearSupabaseSession, 'function', 'clearSupabaseSession debe ser una función.');
});
