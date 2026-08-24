import test from 'node:test';
import assert from 'node:assert';
import systemRouter from '../../src/routes/system';
import { config } from '../../src/config/env';
import { startTestServer, TestServer } from '../helpers/testServer';

// KAN-142: contrato HTTP real de src/routes/system.ts, extraído de src/index.ts. Mezcla rutas
// públicas (config-status), autenticadas por tenant (dashboard-metrics) y por secreto compartido
// (webhook interno) — cada una se testea con el mecanismo de auth que le corresponde.

let server: TestServer;

test('routes/system - setup', async () => {
  server = await startTestServer(systemRouter);
});

test('KAN-142 - GET /api/system/config-status es público y devuelve missingSupabaseCredentials', async () => {
  const res = await fetch(`${server.baseUrl}/api/system/config-status`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.missingSupabaseCredentials));
});

test('KAN-142 - POST /api/dashboard-metrics sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/dashboard-metrics`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - POST /internal/property-match-check sin secreto responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/internal/property-match-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: '00000000-0000-0000-0000-000000000000' })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autorizado.');
});

test('KAN-142 - POST /internal/property-match-check con secreto válido pero property_id inválido responde 400', async () => {
  const res = await fetch(`${server.baseUrl}/internal/property-match-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': config.internalWebhookSecret },
    body: JSON.stringify({ property_id: 'no-es-un-uuid' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'property_id inválido.');
});

test('routes/system - teardown', async () => {
  await server.close();
});
