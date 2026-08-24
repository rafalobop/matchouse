import test from 'node:test';
import assert from 'node:assert';
import notificationsRouter from '../../src/routes/notifications';
import { startTestServer, TestServer } from '../helpers/testServer';

// KAN-142: contrato HTTP real de src/routes/notifications.ts, extraído de src/index.ts. Ambas
// rutas están detrás de tenantAuthMiddleware — sin cookie de sesión deben cortar en 401.

let server: TestServer;

test('routes/notifications - setup', async () => {
  server = await startTestServer(notificationsRouter);
});

test('KAN-142 - GET /api/notifications/vapid-public-key sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/notifications/vapid-public-key`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - POST /api/notifications/subscribe sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/notifications/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: { endpoint: 'https://example.com' } })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('routes/notifications - teardown', async () => {
  await server.close();
});
