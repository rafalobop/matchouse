import test from 'node:test';
import assert from 'node:assert';
import { catalogRoutes } from '../../src/routes/catalogRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-76: contrato HTTP real de src/routes/catalogRoutes.ts (el router activo). Antes de este
// ticket, GET /api/catalog no tenía ningún test contra el router real montado en la app — solo
// existía cobertura (401 sin cookie) contra el src/routes/upload.ts viejo, código muerto desde el
// split a routes/*Routes.ts + controllers/*.

let server: TestServer;

test('routes/catalogRoutes - setup', async () => {
  server = await startTestServer(catalogRoutes);
});

test('KAN-76 - GET /api/catalog sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/catalog`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - GET /api/catalog con cookie de sesión válida devuelve el conteo del tenant (integración con auth real, DB fake)', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: null, error: null, count: 7 }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/catalog`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.count, 7);
});

test('routes/catalogRoutes - teardown', async () => {
  await server.close();
});
