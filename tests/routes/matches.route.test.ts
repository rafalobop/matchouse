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

  const res = await fetch(`${server.baseUrl}/api/matches/11111111-1111-1111-1111-111111111111/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ status: 'NO_ES_UN_STATUS_VALIDO' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'El estado debe ser ACCEPTED o REJECTED');
});

// --- KAN-291: paginación real (limit/offset + total) en vez de .limit(50) fijo sin techo ---

test('KAN-291 - GET /api/matches sin query params usa el default (limit 50, offset 0) y expone total/limit/offset', async (t) => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({
    data: [{
      id: 'match-1', created_at: new Date().toISOString(), raw_search_text: 'depto 2 amb',
      property_snapshot: { address: 'Calle Falsa 123' }, score: 80, reasons: [],
      user_review_status: 'PENDING', feedback_reason: null
    }],
    error: null,
    count: 137
  }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.matches.length, 1);
  assert.strictEqual(body.total, 137, 'Debe exponer el total real (137), no solo la página actual (1 fila mockeada).');
  assert.strictEqual(body.limit, 50);
  assert.strictEqual(body.offset, 0);
});

test('KAN-291 - GET /api/matches con limit/offset explícitos los devuelve tal cual en la respuesta', async (t) => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: [], error: null, count: 0 }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches?limit=10&offset=20`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.limit, 10);
  assert.strictEqual(body.offset, 20);
});

test('KAN-291 - GET /api/matches con limit fuera de rango (0, negativo, o > 200) responde 400', async (t) => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: [], error: null, count: 0 }));
  const { cookie } = createFakeTenantSession(fakeClient);

  for (const limit of ['0', '-5', '201', 'no-es-un-numero']) {
    const res = await fetch(`${server.baseUrl}/api/matches?limit=${limit}`, { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 400, `limit=${limit} debe rechazarse.`);
    const body = await res.json();
    assert.match(body.error, /"limit"/);
  }
});

test('KAN-291 - GET /api/matches con offset negativo o no numérico responde 400', async (t) => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: [], error: null, count: 0 }));
  const { cookie } = createFakeTenantSession(fakeClient);

  for (const offset of ['-1', 'no-es-un-numero']) {
    const res = await fetch(`${server.baseUrl}/api/matches?offset=${offset}`, { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 400, `offset=${offset} debe rechazarse.`);
    const body = await res.json();
    assert.match(body.error, /"offset"/);
  }
});

test('KAN-291 - GET /api/matches/incoming soporta la misma paginación (limit/offset/total)', async (t) => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({
    data: [{
      id: 'match-2', created_at: new Date().toISOString(), raw_search_text: 'busco depto en venta',
      property_snapshot: { address: 'Calle Falsa 123' }, searcher_snapshot: { full_name: 'Juan Pérez' },
      score: 75, reasons: []
    }],
    error: null,
    count: 64
  }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches/incoming?limit=25&offset=25`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.total, 64);
  assert.strictEqual(body.limit, 25);
  assert.strictEqual(body.offset, 25);
});

test('KAN-291 - GET /api/matches/incoming con limit inválido responde 400', async (t) => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: [], error: null, count: 0 }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches/incoming?limit=500`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 400);
});

// KAN-314: confirma que el filtro `.eq('tenant_id', tenantId)` de submitFeedback realmente evita
// que un tenant pise el feedback de un match ajeno — si el id pertenece a otro tenant, el `.eq`
// filtra la fila y Supabase devuelve `data: []` (0 filas afectadas), que el controller debe leer
// como 404, nunca como éxito.
test('KAN-314 - POST /api/matches/:id/feedback con id de un match que no es del tenant responde 404 (no un 200 falso positivo)', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: [], error: null }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches/22222222-2222-2222-2222-222222222222/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ status: 'ACCEPTED' })
  });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error, 'Match no encontrado.');
});

// KAN-134 follow-up: submitFeedback era el único endpoint mutador sin whitelist de body ni cap de
// longitud en `reason` — mismo criterio que ya aplica el resto de rutas (validateBodyWhitelist).
test('POST /api/matches/:id/feedback con campos no permitidos en el body responde 400', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: null, error: null }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches/11111111-1111-1111-1111-111111111111/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ status: 'ACCEPTED', tenant_id: 'otro-tenant' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /campos no permitidos/);
});

test('POST /api/matches/:id/feedback con reason que supera el largo máximo responde 400', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({ data: null, error: null }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/matches/11111111-1111-1111-1111-111111111111/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ status: 'REJECTED', reason: 'x'.repeat(501) })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /500 caracteres/);
});

test('routes/matchesRoutes - teardown', async () => {
  await server.close();
});
