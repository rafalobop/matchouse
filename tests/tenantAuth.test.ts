import test from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { tenantAuthMiddleware } from '../src/middleware/tenantAuth';
import { startTestServer, TestServer } from './helpers/testServer';
import { createFakeTenantSession } from './helpers/fakeSession';
import { createFakeSupabaseClient, chainableResult } from './helpers/fakeSupabaseClient';

// KAN-306 (continuación, 2026-09-04): verifica que tenantAuthMiddleware expone `req.actorId`
// (el auth.uid() real) y `req.tenantId` (el scope efectivo de agencia, ya resuelto) por
// separado — la resolución de `agency_owner_id` en sí (rama de auth fresca, contra el cliente
// service-role real) no tiene seam de test hoy (mismo límite documentado en
// tests/routes/adminPanel.route.test.ts para requireOwner) y queda cubierta por el chequeo de
// integración real contra Supabase, no acá. Esto solo cubre la rama de cache-hit, que es 100%
// determinística sin tocar Supabase.

let server: TestServer;

test('tenantAuth - setup', async () => {
  const router = express.Router();
  router.get('/whoami', tenantAuthMiddleware, (req, res) => {
    res.json({ actorId: (req as any).actorId, tenantId: (req as any).tenantId });
  });
  server = await startTestServer(router);
});

test('KAN-306 - sesión de dueño (actorId === tenantId): /whoami devuelve el mismo id en ambos', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: null, error: null }));
  const { cookie } = createFakeTenantSession(fakeClient, 'owner-1');

  const res = await fetch(`${server.baseUrl}/whoami`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.actorId, 'owner-1');
  assert.strictEqual(body.tenantId, 'owner-1');
});

test('KAN-306 - sesión de colaborador (actorId !== tenantId): /whoami distingue el actor real del scope de agencia', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: null, error: null }));
  const { cookie } = createFakeTenantSession(fakeClient, 'owner-1', 'collaborator-1');

  const res = await fetch(`${server.baseUrl}/whoami`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.actorId, 'collaborator-1');
  assert.strictEqual(body.tenantId, 'owner-1');
});

test('tenantAuth - teardown', async () => {
  await server.close();
});
