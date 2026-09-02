import test from 'node:test';
import assert from 'node:assert';
import { adminPanelRoutes } from '../../src/routes/adminPanelRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-306: contrato HTTP de adminPanelRoutes.ts. Los tres handlers hacen el chequeo de
// "solo dueños" y toda la mutación con el cliente service-role real (`services/supabase.ts#supabase`,
// singleton, sin seam de inyección para tests, mismo límite documentado en search.route.test.ts) —
// acá solo se cubren el gate de sesión (401) y las validaciones que cortan ANTES de tocar Supabase
// (400 por email inválido/id mal formado).

let server: TestServer;

test('routes/adminPanelRoutes - setup', async () => {
  server = await startTestServer(adminPanelRoutes);
});

test('KAN-306 - GET /api/admin-panel/collaborators sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/admin-panel/collaborators`);
  assert.strictEqual(res.status, 401);
});

test('KAN-306 - POST /api/admin-panel/collaborators sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/admin-panel/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'colaborador@example.com' })
  });
  assert.strictEqual(res.status, 401);
});

test('KAN-306 - POST /api/admin-panel/collaborators con cookie válida pero email inválido responde 400 (corta antes de tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/admin-panel/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ email: 'no-es-un-email' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'Email inválido.');
});

test('KAN-306 - POST /api/admin-panel/collaborators con cookie válida y campos no permitidos en el body responde 400', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/admin-panel/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ email: 'colaborador@example.com', role: 'owner' })
  });
  assert.strictEqual(res.status, 400);
});

test('KAN-306 - DELETE /api/admin-panel/collaborators/:id sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/admin-panel/collaborators/some-id`, { method: 'DELETE' });
  assert.strictEqual(res.status, 401);
});

test('KAN-306 - DELETE /api/admin-panel/collaborators/:id con cookie válida pero id mal formado responde 400 (corta antes de tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/admin-panel/collaborators/no-es-un-uuid`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'El ID del colaborador está mal formado.');
});

test('routes/adminPanelRoutes - teardown', async () => {
  await server.close();
});
