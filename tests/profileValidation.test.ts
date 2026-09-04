import test from 'node:test';
import assert from 'node:assert';
import { validateProfileInput, ProfileInput } from '../src/utils/profileValidation';

function baseInput(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    first_name: 'Juan',
    last_name: 'Pérez',
    phone_country_code: '+54',
    phone_local_number: '38155512',
    agency_name: 'Inmobiliaria del Centro',
    city: 'San Miguel de Tucuman',
    license_number: '350',
    ...overrides
  };
}

test('profileValidation - acepta un perfil completo valido', () => {
  assert.strictEqual(validateProfileInput(baseInput()), null);
});

test('profileValidation - rechaza phone_country_code faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_country_code: '' })), null);
});

test('profileValidation - rechaza phone_country_code sin el formato "+dígitos"', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_country_code: '54' })), null);
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_country_code: '+54A' })), null);
});

test('profileValidation - rechaza phone_local_number faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_local_number: '' })), null);
});

test('profileValidation - rechaza phone_local_number con letras', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_local_number: '381ABCD' })), null);
});

test('profileValidation - rechaza phone_local_number con menos de 8 dígitos', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_local_number: '3815551' })), null);
});

test('profileValidation - rechaza phone_local_number con más de 8 dígitos', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ phone_local_number: '123456789' })), null);
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

// --- KAN-306: license_number ---

test('profileValidation - rechaza license_number faltante', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ license_number: undefined })), null);
});

test('profileValidation - rechaza license_number vacío', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ license_number: '   ' })), null);
});

test('profileValidation - rechaza license_number con letras', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ license_number: '35A' })), null);
});

test('profileValidation - rechaza license_number demasiado largo (mas de 10 dígitos)', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ license_number: '1'.repeat(11) })), null);
});

test('profileValidation - acepta license_number con ceros de relleno', () => {
  assert.strictEqual(validateProfileInput(baseInput({ license_number: '001' })), null);
});

// --- KAN-306 (cambio de flujo de colaboradores): requireLicenseNumber=false ---

test('profileValidation - con requireLicenseNumber=false, acepta license_number faltante (colaborador sin matrícula propia)', () => {
  assert.strictEqual(
    validateProfileInput(baseInput({ license_number: undefined }), { requireLicenseNumber: false }),
    null
  );
});

test('profileValidation - con requireLicenseNumber=false, acepta license_number vacío', () => {
  assert.strictEqual(
    validateProfileInput(baseInput({ license_number: '' }), { requireLicenseNumber: false }),
    null
  );
});

test('profileValidation - con requireLicenseNumber=false, igual valida el formato si se manda un valor (colaborador que también es matriculado)', () => {
  assert.notStrictEqual(
    validateProfileInput(baseInput({ license_number: '35A' }), { requireLicenseNumber: false }),
    null
  );
  assert.strictEqual(
    validateProfileInput(baseInput({ license_number: '350' }), { requireLicenseNumber: false }),
    null
  );
});

// --- Punto 2 del pase de UI (2026-09-04): requireAgencyName=false, colaborador hereda la
// inmobiliaria del dueño en vez de mandarla en el body ---

test('profileValidation - con requireAgencyName=false, acepta agency_name faltante (colaborador hereda la del dueño)', () => {
  assert.strictEqual(
    validateProfileInput(baseInput({ agency_name: undefined }), { requireAgencyName: false }),
    null
  );
});

test('profileValidation - agency_name sigue siendo obligatorio por default (dueño)', () => {
  assert.notStrictEqual(validateProfileInput(baseInput({ agency_name: undefined })), null);
});
