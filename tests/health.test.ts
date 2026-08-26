import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { buildHealthPayload } from '../src/utils/health';
import { createApp } from '../src/app';

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
