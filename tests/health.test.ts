import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { buildHealthPayload, checkSupabaseConnectivity } from '../src/utils/health';
import { createApp } from '../src/app';
import { supabase } from '../src/services/supabase';
import { chainableResult } from './helpers/fakeSupabaseClient';

// KAN-141: GET /health delega en buildHealthPayload() (src/utils/health.ts) — se testea la función
// pura acá porque este repo no tiene harness de Express/supertest para src/index.ts (ver
// tests/errorMessageLeak.test.ts).
test('KAN-141 - buildHealthPayload informa liveness true', () => {
  const payload = buildHealthPayload();
  assert.strictEqual(payload.liveness, true);
});

test('KAN-141 - buildHealthPayload incluye uptime como número no negativo', () => {
  const payload = buildHealthPayload();
  assert.strictEqual(typeof payload.uptimeSeconds, 'number');
  assert.ok(payload.uptimeSeconds >= 0);
});

test('KAN-141 - buildHealthPayload incluye uso de memoria en bytes', () => {
  const payload = buildHealthPayload();
  assert.strictEqual(typeof payload.memory.rssBytes, 'number');
  assert.strictEqual(typeof payload.memory.heapTotalBytes, 'number');
  assert.strictEqual(typeof payload.memory.heapUsedBytes, 'number');
  assert.ok(payload.memory.rssBytes > 0);
  assert.ok(payload.memory.heapTotalBytes > 0);
});

test('KAN-141 - buildHealthPayload incluye la carga de CPU (load average) del sistema', () => {
  const payload = buildHealthPayload();
  assert.strictEqual(typeof payload.cpu.loadAvg1m, 'number');
  assert.strictEqual(typeof payload.cpu.loadAvg5m, 'number');
  assert.strictEqual(typeof payload.cpu.loadAvg15m, 'number');
});

test('KAN-141 - buildHealthPayload responde en menos de 300ms', () => {
  const start = Date.now();
  buildHealthPayload();
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 300, `Tardó ${elapsedMs}ms, se esperaba < 300ms`);
});

// KAN-83: hallazgo real — el handler de GET /health en src/app.ts nunca invocaba
// buildHealthPayload() pese a que el comentario de arriba ya lo afirmaba; devolvía solo
// `{status:'ok'}` estático. Corregido — este test ejercita el endpoint HTTP real (createApp(),
// puerto efímero) para que una regresión futura de ese wiring falle acá, no solo a nivel de la
// función pura.
test('KAN-83 - GET /health real (createApp) responde 200 con status:ok y el payload de liveness', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No se pudo determinar el puerto.');

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.liveness, true);
    assert.strictEqual(typeof body.uptimeSeconds, 'number');
    assert.strictEqual(typeof body.memory.rssBytes, 'number');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

// KAN-321: checkSupabaseConnectivity — función pura de src/utils/health.ts, testeada mockeando
// supabase.from() directamente (mismo patrón que tests/helpers/fakeSupabaseClient.ts, sin pegarle
// a una base real).
test('KAN-321 - checkSupabaseConnectivity devuelve ok:true cuando la query no tiene error', async (t) => {
  t.mock.method(supabase, 'from', () => chainableResult({ data: null, error: null, count: 0 }));

  const result = await checkSupabaseConnectivity();
  assert.deepStrictEqual(result, { ok: true });
});

test('KAN-321 - checkSupabaseConnectivity devuelve ok:false con el mensaje de error cuando la query falla', async (t) => {
  t.mock.method(supabase, 'from', () => chainableResult({ data: null, error: { message: 'connection refused' } }));

  const result = await checkSupabaseConnectivity();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'connection refused');
});

test('KAN-321 - checkSupabaseConnectivity devuelve ok:false si supabase.from tira una excepción sincrónica (ej. credenciales faltantes)', async (t) => {
  t.mock.method(supabase, 'from', () => {
    throw new Error('No se puede usar Supabase: faltan las credenciales SUPABASE_URL.');
  });

  const result = await checkSupabaseConnectivity();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'No se puede usar Supabase: faltan las credenciales SUPABASE_URL.');
});

// KAN-321: GET /health/ready real (createApp), mismo criterio de integración que el test KAN-83
// de arriba — ejercita el endpoint HTTP, no solo la función pura.
test('KAN-321 - GET /health/ready responde 200 con supabase:up cuando Supabase está disponible', async (t) => {
  t.mock.method(supabase, 'from', () => chainableResult({ data: null, error: null, count: 0 }));

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No se pudo determinar el puerto.');

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.supabase, 'up');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('KAN-321 - GET /health/ready responde 503 con supabase:down cuando Supabase no está disponible', async (t) => {
  t.mock.method(supabase, 'from', () => chainableResult({ data: null, error: { message: 'timeout' } }));

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No se pudo determinar el puerto.');

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.strictEqual(body.status, 'error');
    assert.strictEqual(body.supabase, 'down');
    assert.strictEqual(body.error, 'timeout');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
