import test from 'node:test';
import assert from 'node:assert';
import { isValidInternalWebhookSecret } from '../src/utils/internalWebhookAuth';

const SECRET = 'a-very-secret-value-1234567890';

test('isValidInternalWebhookSecret - true cuando el header coincide exactamente con el secreto esperado', () => {
  assert.strictEqual(isValidInternalWebhookSecret(SECRET, SECRET), true);
});

test('isValidInternalWebhookSecret - false cuando el header no coincide', () => {
  assert.strictEqual(isValidInternalWebhookSecret('otro-valor', SECRET), false);
});

test('isValidInternalWebhookSecret - false cuando el header tiene distinto largo que el esperado', () => {
  assert.strictEqual(isValidInternalWebhookSecret('corto', SECRET), false);
});

test('isValidInternalWebhookSecret - false cuando el header es undefined (header ausente)', () => {
  assert.strictEqual(isValidInternalWebhookSecret(undefined, SECRET), false);
});

test('isValidInternalWebhookSecret - false cuando el header no es un string', () => {
  assert.strictEqual(isValidInternalWebhookSecret(['x'] as any, SECRET), false);
});

test('isValidInternalWebhookSecret - false cuando el secreto esperado está vacío (config no seteada)', () => {
  assert.strictEqual(isValidInternalWebhookSecret(SECRET, ''), false);
});

test('isValidInternalWebhookSecret - false cuando ambos son el string vacío', () => {
  assert.strictEqual(isValidInternalWebhookSecret('', ''), false);
});
