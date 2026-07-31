import test from 'node:test';
import assert from 'node:assert';
import { isValidUUID } from '../src/utils/idValidation';

test('idValidation - acepta un UUID v4 valido', () => {
  assert.strictEqual(isValidUUID('550e8400-e29b-41d4-a716-446655440000'), true);
});

test('idValidation - acepta un UUID en mayusculas', () => {
  assert.strictEqual(isValidUUID('550E8400-E29B-41D4-A716-446655440000'), true);
});

test('idValidation - rechaza un string vacio', () => {
  assert.strictEqual(isValidUUID(''), false);
});

test('idValidation - rechaza texto arbitrario', () => {
  assert.strictEqual(isValidUUID('hola-mundo'), false);
});

test('idValidation - rechaza un UUID con un segmento de longitud incorrecta', () => {
  assert.strictEqual(isValidUUID('550e8400-e29b-41d4-a716-44665544000'), false);
});

test('idValidation - rechaza intentos de SQL/NoSQL injection en el parametro', () => {
  assert.strictEqual(isValidUUID("550e8400' OR '1'='1"), false);
});

test('idValidation - rechaza valores no-string', () => {
  assert.strictEqual(isValidUUID(undefined), false);
  assert.strictEqual(isValidUUID(null), false);
  assert.strictEqual(isValidUUID(12345), false);
});
