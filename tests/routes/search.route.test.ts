import test from 'node:test';
import assert from 'node:assert';
import searchRouter from '../../src/routes/search';
import { startTestServer, TestServer } from '../helpers/testServer';

// KAN-142: contrato HTTP real de src/routes/search.ts, extraído de src/index.ts. Las cuatro
// rutas están detrás de tenantAuthMiddleware — sin cookie de sesión deben cortar en 401 antes de
// llegar al rate limiter, a la validación de texto o al chequeo de UUID.

let server: TestServer;

test('routes/search - setup', async () => {
  server = await startTestServer(searchRouter);
});

test('KAN-142 - POST /api/search sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'busco depto en barrio norte' })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - GET /api/searches sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/searches`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - DELETE /api/searches/:id sin cookie responde 401 (antes de validar el UUID)', async () => {
  const res = await fetch(`${server.baseUrl}/api/searches/no-es-un-uuid`, { method: 'DELETE' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - POST /api/searches/:id/reactivate sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/searches/no-es-un-uuid/reactivate`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('routes/search - teardown', async () => {
  await server.close();
});
