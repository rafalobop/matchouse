import test from 'node:test';
import assert from 'node:assert';
import {
  buildSentryDataCollectionConfig,
  SENSITIVE_COOKIE_NAMES,
  SENSITIVE_HEADER_NAMES
} from '../src/config/sentryDataCollection';

test('sentryDataCollection (KAN-126) httpBodies queda deshabilitado por completo', () => {
  const config = buildSentryDataCollectionConfig();
  assert.deepStrictEqual(config.httpBodies, [], 'httpBodies debe ser un array vacío — sin captura de bodies HTTP.');
});

test('sentryDataCollection (KAN-126) la cookie de sesión de tenant está en la denylist', () => {
  const config = buildSentryDataCollectionConfig();
  assert.ok(config.cookies.deny.includes('brokaza_session'), 'brokaza_session (access_token del tenant) debe estar excluida.');
});

test('sentryDataCollection (KAN-126) la cookie de sesión de admin está en la denylist', () => {
  const config = buildSentryDataCollectionConfig();
  assert.ok(config.cookies.deny.includes('brokaza_admin_session'), 'brokaza_admin_session (access_token del panel admin) debe estar excluida.');
});

test('sentryDataCollection (KAN-126) la cookie del access gate está en la denylist', () => {
  const config = buildSentryDataCollectionConfig();
  assert.ok(config.cookies.deny.includes('brokaza_access'), 'brokaza_access debe estar excluida.');
});

test('sentryDataCollection (KAN-126) el header Authorization está excluido en request y response', () => {
  const config = buildSentryDataCollectionConfig();
  assert.ok(config.httpHeaders.request.deny.includes('authorization'), 'El header Authorization (Bearer <access_token>) debe estar excluido en requests.');
  assert.ok(config.httpHeaders.response.deny.includes('authorization'), 'El header Authorization debe estar excluido también en responses.');
});

test('sentryDataCollection (KAN-126) el header Cookie crudo está excluido (transporta las cookies de sesión sin filtrar)', () => {
  const config = buildSentryDataCollectionConfig();
  assert.ok(config.httpHeaders.request.deny.includes('cookie'), 'El header Cookie crudo debe excluirse — de lo contrario expone brokaza_session/brokaza_admin_session igual, sin pasar por el filtro de cookies.');
});

test('sentryDataCollection (KAN-126) el secreto interno del webhook de Postgres está excluido', () => {
  const config = buildSentryDataCollectionConfig();
  assert.ok(config.httpHeaders.request.deny.includes('x-internal-secret'), 'x-internal-secret (POST /internal/property-match-check) debe estar excluido.');
});

test('sentryDataCollection (KAN-126) cada llamada devuelve un objeto nuevo, sin compartir arrays mutables entre sí', () => {
  const configA = buildSentryDataCollectionConfig();
  const configB = buildSentryDataCollectionConfig();
  configA.cookies.deny.push('otra-cookie-de-prueba');
  assert.strictEqual(
    configB.cookies.deny.includes('otra-cookie-de-prueba'),
    false,
    'Mutar el resultado de una llamada no debe afectar a otra — cada config debe ser independiente.'
  );
});

test('sentryDataCollection (KAN-126) las constantes de metadata no están vacías', () => {
  assert.ok(SENSITIVE_COOKIE_NAMES.length > 0, 'SENSITIVE_COOKIE_NAMES no debe quedar vacía.');
  assert.ok(SENSITIVE_HEADER_NAMES.length > 0, 'SENSITIVE_HEADER_NAMES no debe quedar vacía.');
});
