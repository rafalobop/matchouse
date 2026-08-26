import test from 'node:test';
import assert from 'node:assert';
import { matchesRoutes } from '../../src/routes/matchesRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-76: contrato HTTP real de src/routes/matchesRoutes.ts (el router activo). Reemplaza a
// tests/routes/matches.route.test.ts, que testeaba src/routes/matches.ts — código muerto desde
// el split a routes/*Routes.ts + controllers/*, nunca montado en la app real.

let server: TestServer;

test('routes/matchesRoutes - setup', async () => {
  server = await startTestServer(matchesRoutes);
});

test('KAN-76 - GET /api/matches sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/matches`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - GET /api/matches/incoming sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/matches/incoming`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - POST /api/matches/:id/feedback sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/matches/some-id/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ACCEPTED' })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - GET /api/matches con cookie de sesión válida devuelve los matches del tenant (integración con auth real, DB fake)', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({
    data: [{
      id: 'match-1', created_at: new Date().toISOString(), raw_search_text: 'depto 2 amb',
      property_snapshot: { address: 'Calle Falsa 123' }, score: 80, reasons: [],
      user_review_status: 'PENDING', feedback_reason: null
    }],
    error: null
  }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.matches.length, 1);
});

test('KAN-76 (QA follow-up) - GET /api/matches/incoming con cookie de sesión válida devuelve los matches entrantes (integración con auth real, DB fake)', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({
    data: [{
      id: 'match-2', created_at: new Date().toISOString(), raw_search_text: 'busco depto en venta',
      property_snapshot: { address: 'Calle Falsa 123' }, searcher_snapshot: { full_name: 'Juan Pérez' },
      score: 75, reasons: []
    }],
    error: null
  }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches/incoming`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.matches.length, 1);
});

test('KAN-76 - POST /api/matches/:id/feedback con status inválido responde 400 (con sesión válida)', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: null, error: null }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches/some-id/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ status: 'NO_ES_UN_STATUS_VALIDO' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'El estado debe ser ACCEPTED o REJECTED');
});

test('routes/matchesRoutes - teardown', async () => {
  await server.close();
});
