import test from 'node:test';
import assert from 'node:assert';
import { searchRoutes } from '../../src/routes/searchRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-76 (QA follow-up): searchRoutes.ts nunca tuvo un test de router HTTP — quedó en 0% de
// cobertura en el reporte de QA. `archiveSearch`/`reactivateSearch` (DELETE/POST reactivate) hacen
// el chequeo privilegiado de dueño con el cliente service-role real (`services/supabase.ts#supabase`,
// singleton, sin seam de inyección para tests — a diferencia de `req.supabaseClient`) — por eso acá
// solo se cubren las ramas de validación que cortan ANTES de tocar Supabase (400 por id inválido,
// 400 por texto vacío); cubrir el happy path completo de esas dos rutas requeriría un mock del
// singleton service-role, que no existe hoy (ver nota en tests/helpers/fakeSession.ts) — fuera de
// alcance de este pase, documentado para no dar falsa sensación de cobertura.

let server: TestServer;

test('routes/searchRoutes - setup', async () => {
  server = await startTestServer(searchRoutes);
});

test('KAN-76 - POST /api/search sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'busco depto en Yerba Buena' })
  });
  assert.strictEqual(res.status, 401);
});

test('KAN-76 - POST /api/search con cookie válida pero texto vacío responde 400 (corta antes de tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text: '' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'El texto de búsqueda es requerido.');
});

test('KAN-76 - GET /api/searches sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/searches`);
  assert.strictEqual(res.status, 401);
});

test('KAN-76 - GET /api/searches con cookie válida devuelve la lista del tenant (integración con auth real, DB fake)', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table !== 'active_searches') throw new Error(`tabla inesperada: ${table}`);
    return chainableResult({ data: [], error: null });
  });
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/searches`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { searches: [] });
});

test('KAN-76 - DELETE /api/searches/:id sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/searches/some-id`, { method: 'DELETE' });
  assert.strictEqual(res.status, 401);
});

test('KAN-76 - DELETE /api/searches/:id con cookie válida pero id mal formado responde 400 (corta antes de tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/searches/no-es-un-uuid`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'El ID de la búsqueda está mal formado.');
});

test('KAN-76 - POST /api/searches/:id/reactivate sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/searches/some-id/reactivate`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
});

test('KAN-76 - POST /api/searches/:id/reactivate con cookie válida pero id mal formado responde 400 (corta antes de tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/searches/no-es-un-uuid/reactivate`, { method: 'POST', headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'El ID de la búsqueda está mal formado.');
});

test('routes/searchRoutes - teardown', async () => {
  await server.close();
});
