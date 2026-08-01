import test from 'node:test';
import assert from 'node:assert';
import { validateProfileInput, ProfileInput } from '../src/utils/profileValidation';

function baseInput(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    first_name: 'Juan',
    last_name: 'Pérez',
    phone_number: '+54 381 555-1234',
    agency_name: 'Inmobiliaria del Centro',
    city: 'San Miguel de Tucuman',
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

test('profileValidation - rechaza tipos no-string (proteccion contra payloads inesperados)', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ agency_name: 12345 })), null);
});

// --- KAN-90: first_name / last_name ---

test('profileValidation - rechaza first_name faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ first_name: '' })), null);
});

test('profileValidation - rechaza last_name faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ last_name: undefined })), null);
});

test('profileValidation - rechaza first_name de un solo caracter (minimo 2)', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ first_name: 'J' })), null);
});

test('profileValidation - rechaza first_name demasiado largo (mas de 100)', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ first_name: 'a'.repeat(101) })), null);
});

test('profileValidation - rechaza first_name con digitos', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ first_name: 'Juan123' })), null);
});

test('profileValidation - rechaza last_name con simbolos no permitidos', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ last_name: 'Pérez@Test' })), null);
});

test('profileValidation - acepta nombres compuestos, con guion y con apostrofe', () => {
  assert.strictEqual(validateProfileInput(baseInput({ first_name: 'María José', last_name: "O'Connor-García" })), null);
});

test('profileValidation - acepta nombres con acentos y ñ', () => {
  assert.strictEqual(validateProfileInput(baseInput({ first_name: 'Ñañez', last_name: 'Muñoz' })), null);
});
