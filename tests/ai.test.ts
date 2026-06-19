import test from 'node:test';
import assert from 'node:assert';
import { extractRealEstateRequest, extractZoneIntent, validateMatch } from '../src/services/ai';

test('AI Service - Debería exportar las funciones clave', () => {
  assert.strictEqual(typeof extractRealEstateRequest, 'function', 'extractRealEstateRequest debe ser una función.');
  assert.strictEqual(typeof extractZoneIntent, 'function', 'extractZoneIntent debe ser una función.');
  assert.strictEqual(typeof validateMatch, 'function', 'validateMatch debe ser una función.');
});
