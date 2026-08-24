import test from 'node:test';
import assert from 'node:assert';
import matchesRouter from '../../src/routes/matches';
import { startTestServer, TestServer } from '../helpers/testServer';

// KAN-142: contrato HTTP real de src/routes/matches.ts, extraído de src/index.ts. Las tres rutas
// están detrás de tenantAuthMiddleware — sin cookie de sesión deben cortar en 401 sin llegar a
// Supabase ni a la validación del body de feedback.

let server: TestServer;

test('routes/matches - setup', async () => {
  server = await startTestServer(matchesRouter);
});

test('KAN-142 - GET /api/matches sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/matches`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - GET /api/matches/incoming sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/matches/incoming`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-142 - POST /api/matches/:id/feedback sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/matches/some-id/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ACCEPTED' })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('routes/matches - teardown', async () => {
  await server.close();
});
