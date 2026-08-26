import test from 'node:test';
import assert from 'node:assert';
import { systemRoutes } from '../../src/routes/systemRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-76: contrato HTTP real de src/routes/systemRoutes.ts. GET /api/system/config-status y
// POST /api/dashboard-metrics (KAN-122/KAN-128) solo existían en el src/routes/system.ts viejo,
// nunca montado tras el split a routes/*Routes.ts + controllers/* (commit "add: new routes
// structure", 2026-08-24) — estaban rotos en producción hasta este ticket (mismo patrón de bug
// que KAN-273 en routes/index.ts). El webhook interno se testea en tests/routes/internal.route.test.ts
// (ya vive en internalRoutes.ts, montado desde antes).

let server: TestServer;

test('routes/systemRoutes - setup', async () => {
  server = await startTestServer(systemRoutes);
});

test('KAN-76 - GET /api/system/config-status es público y devuelve missingSupabaseCredentials', async () => {
  const res = await fetch(`${server.baseUrl}/api/system/config-status`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.missingSupabaseCredentials));
});

test('KAN-76 - POST /api/dashboard-metrics sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/dashboard-metrics`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - POST /api/dashboard-metrics con cookie de sesión válida responde 204 (integración con auth real de punta a punta)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/dashboard-metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ windowMs: 60000, socketOpens: 1 })
  });
  assert.strictEqual(res.status, 204);
});

test('routes/systemRoutes - teardown', async () => {
  await server.close();
});
