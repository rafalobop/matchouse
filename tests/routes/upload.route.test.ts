import test from 'node:test';
import assert from 'node:assert';
import { uploadRoutes } from '../../src/routes/uploadRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-76: contrato HTTP real de src/routes/uploadRoutes.ts (el router activo). Reemplaza a
// tests/routes/upload.route.test.ts, que testeaba src/routes/upload.ts — código muerto desde el
// split a routes/*Routes.ts + controllers/*, nunca montado en la app real. GET /api/catalog vive
// ahora en catalogRoutes.ts (ver tests/routes/catalog.route.test.ts), no acá.

let server: TestServer;

test('routes/uploadRoutes - setup', async () => {
  server = await startTestServer(uploadRoutes);
});

test('KAN-76 - POST /api/upload sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/upload`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - POST /api/upload/confirm-mapping sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/upload/confirm-mapping`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 (QA follow-up) - POST /api/upload con cookie válida pero sin archivo responde 400 (integración con auth real, sin tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: new FormData()
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'No se subió ningún archivo');
});

test('KAN-76 (QA follow-up) - POST /api/upload/confirm-mapping con cookie válida pero sin archivo responde 400 (integración con auth real, sin tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/upload/confirm-mapping`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: new FormData()
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'No se subió ningún archivo');
});

test('routes/uploadRoutes - teardown', async () => {
  await server.close();
});
