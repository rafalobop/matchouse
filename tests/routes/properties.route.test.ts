import test from 'node:test';
import assert from 'node:assert';
import propertiesRouter from '../../src/routes/properties';
import { startTestServer, TestServer } from '../helpers/testServer';

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

test('routes/properties - teardown', async () => {
  await server.close();
});
