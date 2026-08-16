import test from 'node:test';
import assert from 'node:assert';
import { buildHealthPayload } from '../src/utils/health';

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
