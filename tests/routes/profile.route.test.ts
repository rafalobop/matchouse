import test from 'node:test';
import assert from 'node:assert';
import profileRouter from '../../src/routes/profile';
import { startTestServer, TestServer } from '../helpers/testServer';

// KAN-142: contrato HTTP real de src/routes/profile.ts, extraído de src/index.ts. Las tres rutas
// están detrás de tenantAuthMiddleware — sin cookie de sesión, deben cortar en 401 antes de tocar
// Supabase (validación de body/negocio se testea aparte en tests/profileValidation.test.ts).

let server: TestServer;

test('routes/profile - setup', async () => {
  server = await startTestServer(profileRouter);
});

test('KAN-142 - GET /api/localities/tucuman sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/localities/tucuman`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - GET /api/profile sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/profile`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - POST /api/profile sin cookie responde 401 (corta antes de validar el body)', async () => {
  const res = await fetch(`${server.baseUrl}/api/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'Juan' })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('routes/profile - teardown', async () => {
  await server.close();
});
