import test from 'node:test';
import assert from 'node:assert';
import { notificationsRoutes } from '../../src/routes/notificationsRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-76: contrato HTTP real de src/routes/notificationsRoutes.ts (el router activo). Reemplaza a
// tests/routes/notifications.route.test.ts, que testeaba src/routes/notifications.ts — código
// muerto desde el split a routes/*Routes.ts + controllers/*, nunca montado en la app real.

let server: TestServer;

test('routes/notificationsRoutes - setup', async () => {
  server = await startTestServer(notificationsRoutes);
});

test('KAN-76 - GET /api/notifications/vapid-public-key sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/notifications/vapid-public-key`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - POST /api/notifications/subscribe sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/notifications/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: { endpoint: 'https://example.com' } })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - GET /api/notifications/vapid-public-key con cookie de sesión válida devuelve la clave (integración con auth real)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/notifications/vapid-public-key`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok('publicKey' in body);
});

test('KAN-76 - POST /api/notifications/subscribe con cookie válida pero body con campo inesperado responde 400 (whitelist KAN-134)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/notifications/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ subscription: { endpoint: 'https://example.com' }, extraCampo: 'no debería aceptarse' })
  });
  assert.strictEqual(res.status, 400);
});

test('KAN-76 - POST /api/notifications/subscribe con cookie válida y suscripción nueva persiste (integración con auth real, DB fake)', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table !== 'web_push_subscriptions') throw new Error(`tabla inesperada: ${table}`);
    return chainableResult({ data: null, error: null });
  });
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/notifications/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ subscription: { endpoint: 'https://example.com/push/abc' } })
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { success: true });
});

test('routes/notificationsRoutes - teardown', async () => {
  await server.close();
});
