import test from 'node:test';
import assert from 'node:assert';
import propertiesRouter from '../../src/routes/properties';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-273: contrato HTTP de src/routes/properties.ts. Las cuatro rutas están detrás de
// tenantAuthMiddleware — sin cookie de sesión deben cortar en 401 sin llegar a Supabase.

let server: TestServer;

test('routes/properties - setup', async () => {
  server = await startTestServer(propertiesRouter);
});

test('KAN-273 - GET /api/catalog/properties sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/catalog/properties`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-273 - POST /api/catalog/properties sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/catalog/properties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'Calle Falsa 123' })
  });
  assert.strictEqual(res.status, 401);
});

test('KAN-273 - PATCH /api/catalog/properties/:id sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/catalog/properties/some-id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: 100 })
  });
  assert.strictEqual(res.status, 401);
});

test('KAN-273 - DELETE /api/catalog/properties/:id sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/catalog/properties/some-id`, { method: 'DELETE' });
  assert.strictEqual(res.status, 401);
});

test('KAN-76 (QA follow-up) - GET /api/catalog/properties con cookie válida devuelve la lista vacía del tenant (integración con auth real, DB fake)', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table !== 'properties') throw new Error(`tabla inesperada: ${table}`);
    return chainableResult({ data: [], error: null, count: 0 });
  });
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/catalog/properties`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { properties: [], total: 0 });
});

test('KAN-76 (QA follow-up) - POST /api/catalog/properties con cookie válida pero body inválido responde 400 (corta antes de tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/catalog/properties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({})
  });
  assert.strictEqual(res.status, 400);
});

test('KAN-76 (QA follow-up) - PATCH /api/catalog/properties/:id con cookie válida pero sin expectedUpdatedAt responde 400 (corta antes de tocar Supabase)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/catalog/properties/some-id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ price: 100 })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'El campo "expectedUpdatedAt" es requerido para editar una propiedad.');
});

test('KAN-76 (QA follow-up) - DELETE /api/catalog/properties/:id con cookie válida de un dueño elimina la propiedad (integración con auth real, DB fake)', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table === 'profiles') return chainableResult({ data: { role: 'owner' }, error: null });
    if (table === 'properties') return chainableResult({ data: [{ id: 'property-1' }], error: null });
    throw new Error(`tabla inesperada: ${table}`);
  });
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/catalog/properties/property-1`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { success: true });
});

// KAN-306 (continuación, 2026-09-04): un colaborador (role='collaborator') nunca puede eliminar
// propiedades, aunque su `tenantId` resuelva al scope de agencia del dueño — solo el dueño real.
test('KAN-306 - DELETE /api/catalog/properties/:id con cookie de un colaborador responde 403 sin llegar a intentar el delete', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table === 'profiles') return chainableResult({ data: { role: 'collaborator' }, error: null });
    throw new Error(`tabla inesperada para un colaborador: ${table}`);
  });
  const { cookie } = createFakeTenantSession(fakeClient, 'owner-1', 'collaborator-1');

  const res = await fetch(`${server.baseUrl}/api/catalog/properties/property-1`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 403);
  const body = await res.json();
  assert.strictEqual(body.error, 'Solo el dueño de la agencia puede eliminar propiedades.');
});

// KAN-314: PATCH usa `.eq('id', id).eq('tenant_id', tenantId).eq('updated_at', expectedUpdatedAt)`.
// Si el id es de otro tenant, ese `.eq('tenant_id', ...)` filtra la fila igual que si no existiera
// — la segunda lectura (sin el filtro de updated_at, para distinguir 404 de 409) también respeta
// `tenant_id`, así que debe dar 404 limpio, sin filtrar ni el estado actual de la propiedad ajena.
test('KAN-314 - PATCH /api/catalog/properties/:id con id de una propiedad que no es del tenant responde 404 (no filtra datos ni cae en 409)', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table !== 'properties') throw new Error(`tabla inesperada: ${table}`);
    // El update filtrado por tenant_id devuelve 0 filas; el fallback (.maybeSingle(), sin el
    // filtro de updated_at) también respeta tenant_id y no encuentra la fila ajena -> null.
    return chainableResult({ data: null, error: null });
  });
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/catalog/properties/otro-tenant-property-id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ price: 100, expectedUpdatedAt: new Date().toISOString() })
  });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error, 'Propiedad no encontrada.');
});

// KAN-314: DELETE también filtra por `tenant_id` además del chequeo de dueño — un id de otro
// tenant no debe borrar nada ni devolver éxito, aunque el actor sea dueño de SU propia agencia.
test('KAN-314 - DELETE /api/catalog/properties/:id con id de una propiedad que no es del tenant responde 404 (el .eq tenant_id la filtra)', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table === 'profiles') return chainableResult({ data: { role: 'owner' }, error: null });
    if (table === 'properties') return chainableResult({ data: [], error: null }); // filtrada por tenant_id, 0 filas
    throw new Error(`tabla inesperada: ${table}`);
  });
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/catalog/properties/otro-tenant-property-id`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error, 'Propiedad no encontrada.');
});

// KAN-305: latitude/longitude salieron de UPDATE_FIELDS — un tenant que las manda en el PATCH
// debe cortar en 400 por la whitelist, antes de tocar Supabase (nunca llega a pisar el geocoding).
test('KAN-305 - PATCH /api/catalog/properties/:id con latitude en el body responde 400 (whitelist, ya no es un campo editable por el tenant)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/catalog/properties/property-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ latitude: -26.8, expectedUpdatedAt: new Date().toISOString() })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'El body contiene campos no permitidos: latitude.');
});

test('KAN-305 - POST /api/catalog/properties/:id/request_correction sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/catalog/properties/some-id/request_correction`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
});

test('KAN-305 - POST /api/catalog/properties/:id/request_correction con cookie válida marca needs_coordinate_review sin tocar las coordenadas', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table !== 'properties') throw new Error(`tabla inesperada: ${table}`);
    return chainableResult({
      data: { id: 'property-1', address: 'Calle Falsa 123', latitude: -26.8, longitude: -65.2, needs_coordinate_review: true },
      error: null
    });
  });
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/catalog/properties/property-1/request_correction`, {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.property.needs_coordinate_review, true);
  assert.strictEqual(body.property.latitude, -26.8);
  assert.strictEqual(body.property.longitude, -65.2);
});

test('KAN-305 - POST /api/catalog/properties/:id/request_correction con id de una propiedad que no es del tenant responde 404', async () => {
  const fakeClient = createFakeSupabaseClient((table: string) => {
    if (table !== 'properties') throw new Error(`tabla inesperada: ${table}`);
    return chainableResult({ data: null, error: null }); // filtrada por tenant_id, 0 filas
  });
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/catalog/properties/otro-tenant-property-id/request_correction`, {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error, 'Propiedad no encontrada.');
});

test('routes/properties - teardown', async () => {
  await server.close();
});
