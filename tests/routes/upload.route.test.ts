import test from 'node:test';
import assert from 'node:assert';
import uploadRouter from '../../src/routes/upload';
import { startTestServer, TestServer } from '../helpers/testServer';

// KAN-142: contrato HTTP real de src/routes/upload.ts, extraído de src/index.ts. Las tres rutas
// están detrás de tenantAuthMiddleware, que corre ANTES del rate limiter y de multer — sin cookie
// de sesión deben cortar en 401 sin llegar a parsear ningún archivo.

let server: TestServer;

test('routes/upload - setup', async () => {
  server = await startTestServer(uploadRouter);
});

test('KAN-142 - POST /api/upload sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/upload`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - POST /api/upload/confirm-mapping sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/upload/confirm-mapping`, { method: 'POST' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - GET /api/catalog sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/catalog`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('routes/upload - teardown', async () => {
  await server.close();
});
