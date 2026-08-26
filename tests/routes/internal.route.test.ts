import test from 'node:test';
import assert from 'node:assert';
import { internalRoutes } from '../../src/routes/internalRoutes';
import { config } from '../../src/config/env';
import { startTestServer, TestServer } from '../helpers/testServer';

// KAN-76: contrato HTTP real de src/routes/internalRoutes.ts (el router activo). Antes de este
// ticket, POST /internal/property-match-check solo tenía cobertura contra el src/routes/system.ts
// viejo, código muerto desde el split a routes/*Routes.ts + controllers/*.

let server: TestServer;

test('routes/internalRoutes - setup', async () => {
  server = await startTestServer(internalRoutes);
});

test('KAN-76 - POST /internal/property-match-check sin secreto responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/internal/property-match-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: '00000000-0000-0000-0000-000000000000' })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autorizado.');
});

test('KAN-76 - POST /internal/property-match-check con secreto válido pero property_id inválido responde 400', async () => {
  const res = await fetch(`${server.baseUrl}/internal/property-match-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': config.internalWebhookSecret },
    body: JSON.stringify({ property_id: 'no-es-un-uuid' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'property_id inválido.');
});

test('routes/internalRoutes - teardown', async () => {
  await server.close();
});
