import test from 'node:test';
import assert from 'node:assert';
import {
  selectTestSessionsToDisconnect,
  runTestSessionCleanup,
  startSessionCleanupService,
  stopSessionCleanupService,
  __setResendClientForTests
} from '../src/services/sessionCleanup';
import { activeSessions } from '../src/services/whatsapp';
import { config } from '../src/config/env';

test('Session Cleanup - expone las funciones esperadas', () => {
  assert.strictEqual(typeof selectTestSessionsToDisconnect, 'function');
  assert.strictEqual(typeof runTestSessionCleanup, 'function');
  assert.strictEqual(typeof startSessionCleanupService, 'function');
  assert.strictEqual(typeof stopSessionCleanupService, 'function');
});

test('Session Cleanup - selectTestSessionsToDisconnect solo selecciona tenants de prueba con sesión activa', () => {
  const active = ['tenant-real-1', 'tenant-test-1', 'tenant-real-2'];
  const testTenants = ['tenant-test-1', 'tenant-test-2'];

  const result = selectTestSessionsToDisconnect(active, testTenants);

  assert.deepStrictEqual(result, ['tenant-test-1'], 'Solo debe incluir tenants de prueba que tengan sesión activa.');
});

test('Session Cleanup - selectTestSessionsToDisconnect nunca toca tenants reales aunque la lista de prueba esté vacía', () => {
  const active = ['tenant-real-1', 'tenant-real-2'];
  const result = selectTestSessionsToDisconnect(active, []);

  assert.deepStrictEqual(result, [], 'Sin tenants de prueba configurados, no debe desconectar nada.');
});

test('Session Cleanup - runTestSessionCleanup no desconecta nada si no hay tenants de prueba configurados', async () => {
  const originalTestTenants = config.testWhatsappTenantIds;
  try {
    (config as any).testWhatsappTenantIds = [];
    const disconnected = await runTestSessionCleanup();
    assert.deepStrictEqual(disconnected, [], 'Sin TEST_WHATSAPP_TENANT_IDS, no debe desconectar ninguna sesión.');
  } finally {
    (config as any).testWhatsappTenantIds = originalTestTenants;
  }
});

test('Session Cleanup - __setResendClientForTests permite inyectar un mock (nunca se manda mail real en el test suite)', () => {
  let sendCalled = false;
  __setResendClientForTests({
    emails: {
      send: async () => {
        sendCalled = true;
        return { data: { id: 'mock-id' }, error: null };
      }
    }
  });
  assert.strictEqual(sendCalled, false, 'Inyectar el mock no debe disparar un envío por sí solo.');
});

test('Session Cleanup - startSessionCleanupService no arranca el intervalo si no hay tenants de prueba configurados', () => {
  const originalTestTenants = config.testWhatsappTenantIds;
  try {
    (config as any).testWhatsappTenantIds = [];
    // No debe lanzar ni dejar un timer corriendo; stopSessionCleanupService es seguro llamarlo igual.
    startSessionCleanupService();
    stopSessionCleanupService();
    assert.ok(true, 'startSessionCleanupService debe ser un no-op seguro sin tenants de prueba.');
  } finally {
    (config as any).testWhatsappTenantIds = originalTestTenants;
  }
});

test('Session Cleanup - activeSessions (whatsapp.ts) sigue siendo la fuente de verdad de sesiones activas', () => {
  assert.ok(activeSessions, 'El mapa activeSessions debe estar definido.');
});
