import test from 'node:test';
import assert from 'node:assert';
import { validateFreeSearchText } from '../src/utils/searchValidation';

test('searchValidation - acepta texto válido en español con tildes, ñ, emojis y puntuación normal', () => {
  const text = 'Busco depto de 2 dormitorios en Yerba Buena, hasta 80.000 USD 🏠 ¡urgente!';
  assert.strictEqual(validateFreeSearchText(text), null);
});

test('searchValidation - rechaza texto por debajo del mínimo de 10 caracteres', () => {
  assert.notStrictEqual(validateFreeSearchText('hola'), null);
});

test('searchValidation - acepta texto de exactamente 10 caracteres', () => {
  const text = '1234567890';
  assert.strictEqual(validateFreeSearchText(text), null);
});

test('searchValidation - rechaza texto de 9 caracteres', () => {
  const text = '123456789';
  assert.notStrictEqual(validateFreeSearchText(text), null);
});

test('searchValidation - acepta texto de exactamente 1000 caracteres', () => {
  const text = 'a'.repeat(1000);
  assert.strictEqual(validateFreeSearchText(text), null);
});

test('searchValidation - rechaza texto de 1001 caracteres', () => {
  const text = 'a'.repeat(1001);
  assert.notStrictEqual(validateFreeSearchText(text), null);
});

test('searchValidation - rechaza caracteres de control (NUL, ESC, DEL)', () => {
  assert.notStrictEqual(validateFreeSearchText('busco depto \x00 en centro'), null);
  assert.notStrictEqual(validateFreeSearchText('busco depto \x1B en centro'), null);
  assert.notStrictEqual(validateFreeSearchText('busco depto \x7F en centro'), null);
});

test('searchValidation - acepta texto multilínea con \\n y \\r', () => {
  const text = 'Busco depto\nen zona norte,\r\nhasta 2 dormitorios y cochera.';
  assert.strictEqual(validateFreeSearchText(text), null);
});
