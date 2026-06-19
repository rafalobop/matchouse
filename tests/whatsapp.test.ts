import test from 'node:test';
import assert from 'node:assert';
import { activeSessions, sessionStatuses, initTenantSession, logoutTenantSession } from '../src/services/whatsapp';

test('WhatsApp Service - Debería estar listo para administrar sesiones y hooks', () => {
  assert.ok(activeSessions, 'El mapa activeSessions debe estar definido.');
  assert.ok(sessionStatuses, 'El mapa sessionStatuses debe estar definido.');
  assert.strictEqual(typeof initTenantSession, 'function', 'initTenantSession debe ser una función.');
  assert.strictEqual(typeof logoutTenantSession, 'function', 'logoutTenantSession debe ser una función.');
});
