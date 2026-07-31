import test from 'node:test';
import assert from 'node:assert';
import { validateProfileInput, ProfileInput } from '../src/utils/profileValidation';

function baseInput(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    phone_number: '+54 381 555-1234',
    agency_name: 'Inmobiliaria del Centro',
    city: 'San Miguel de Tucuman',
    country: 'Argentina',
    ...overrides
  };
}

test('profileValidation - acepta un perfil completo valido', () => {
  assert.strictEqual(validateProfileInput(baseInput()), null);
});

test('profileValidation - rechaza phone_number faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_number: '' })), null);
});

test('profileValidation - rechaza phone_number con letras', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_number: '381-ABCD' })), null);
});

test('profileValidation - rechaza phone_number demasiado largo', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_number: '1'.repeat(21) })), null);
});

test('profileValidation - rechaza agency_name faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ agency_name: '   ' })), null);
});

test('profileValidation - rechaza city faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ city: undefined })), null);
});

test('profileValidation - rechaza country faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ country: null })), null);
});

test('profileValidation - rechaza tipos no-string (proteccion contra payloads inesperados)', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ agency_name: 12345 })), null);
});
