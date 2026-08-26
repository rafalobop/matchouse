import test from 'node:test';
import assert from 'node:assert';
import { authRoutes } from '../../src/routes/authRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';

// KAN-76: contrato HTTP real de src/routes/authRoutes.ts (el router activo, montado vía
// src/routes/index.ts). Reemplaza a tests/routes/auth.route.test.ts, que testeaba
// src/routes/auth.ts — código muerto desde el split a routes/*Routes.ts + controllers/*
// (commit "add: new routes structure", 2026-08-24), nunca montado en la app real. Cubre las
// validaciones/branches que no dependen de una llamada real a Supabase Auth (email inválido,
// falta de body, sesión ausente).

let server: TestServer;

test('routes/authRoutes - setup', async () => {
  server = await startTestServer(authRoutes);
});

test('KAN-76 - GET /api/auth/session sin cookie responde authenticated:false', async () => {
  const res = await fetch(`${server.baseUrl}/api/auth/session`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { authenticated: false });
});

test('KAN-76 - POST /api/auth/request-magic-link sin email responde 400', async () => {
  const res = await fetch(`${server.baseUrl}/api/auth/request-magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'Email inválido.');
});

test('KAN-76 - POST /api/auth/request-magic-link con email mal formado (sin @) responde 400', async () => {
  const res = await fetch(`${server.baseUrl}/api/auth/request-magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'no-es-un-email' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'Email inválido.');
});

test('KAN-76 - POST /api/auth/exchange-token sin access_token responde 400', async () => {
  const res = await fetch(`${server.baseUrl}/api/auth/exchange-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'Token requerido.');
});

test('KAN-76 - POST /api/auth/logout responde success:true y limpia la cookie de sesión', async () => {
  const res = await fetch(`${server.baseUrl}/api/auth/logout`, { method: 'POST' });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { success: true });
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /brokaza_session=;/, 'Debe instruir al browser a borrar la cookie brokaza_session.');
});

test('routes/authRoutes - teardown', async () => {
  await server.close();
});
