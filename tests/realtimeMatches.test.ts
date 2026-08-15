import test from 'node:test';
import assert from 'node:assert';
import * as path from 'path';

// realtimeMatches.js es un script de browser plano (sin tipos ni allowJs habilitado en tsconfig),
// se carga con require() en vez de import por el mismo motivo que ios-onboarding.js (ver ese test).
const {
  buildMatchCountSocketUrl,
  shouldRefetchOnMessage,
  nextReconnectDelayMs,
  randomIntervalMs,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  FALLBACK_POLL_MIN_MS,
  FALLBACK_POLL_MAX_MS
} = require(path.join('..', 'src', 'dashboard', 'realtimeMatches'));

test('buildMatchCountSocketUrl (KAN-88) - usa wss:// cuando la página está en https', () => {
  const url = buildMatchCountSocketUrl({ protocol: 'https:', host: 'app.matchouse.com' });
  assert.strictEqual(url, 'wss://app.matchouse.com/ws');
});

test('buildMatchCountSocketUrl (KAN-88) - usa ws:// cuando la página está en http (dev local)', () => {
  const url = buildMatchCountSocketUrl({ protocol: 'http:', host: 'localhost:3000' });
  assert.strictEqual(url, 'ws://localhost:3000/ws');
});

test('shouldRefetchOnMessage (KAN-88) - true para el evento real emitido por el backend', () => {
  assert.strictEqual(shouldRefetchOnMessage(JSON.stringify({ type: 'match_count_changed' })), true);
});

test('shouldRefetchOnMessage (KAN-88) - false para un tipo de evento desconocido', () => {
  assert.strictEqual(shouldRefetchOnMessage(JSON.stringify({ type: 'algo_no_relacionado' })), false);
});

test('shouldRefetchOnMessage (KAN-88) - false para JSON inválido, sin tirar una excepción', () => {
  assert.doesNotThrow(() => {
    assert.strictEqual(shouldRefetchOnMessage('esto no es JSON'), false);
  });
});

test('shouldRefetchOnMessage (KAN-88) - false para un payload JSON válido pero sin `type`', () => {
  assert.strictEqual(shouldRefetchOnMessage(JSON.stringify({ foo: 'bar' })), false);
});

test('shouldRefetchOnMessage (KAN-88) - false para null/undefined/vacío', () => {
  assert.strictEqual(shouldRefetchOnMessage('null'), false);
  assert.strictEqual(shouldRefetchOnMessage(''), false);
});

test('nextReconnectDelayMs (KAN-88) - duplica el delay anterior', () => {
  assert.strictEqual(nextReconnectDelayMs(1000), 2000);
  assert.strictEqual(nextReconnectDelayMs(2000), 4000);
});

test('nextReconnectDelayMs (KAN-88) - no supera el tope por default (15s)', () => {
  assert.strictEqual(nextReconnectDelayMs(10000), DEFAULT_MAX_DELAY_MS);
  assert.strictEqual(nextReconnectDelayMs(DEFAULT_MAX_DELAY_MS), DEFAULT_MAX_DELAY_MS);
});

test('nextReconnectDelayMs (KAN-88) - respeta un tope custom si se pasa explícito', () => {
  assert.strictEqual(nextReconnectDelayMs(4000, 5000), 5000);
});

test('DEFAULT_INITIAL_DELAY_MS (KAN-88) - arranca en 1s', () => {
  assert.strictEqual(DEFAULT_INITIAL_DELAY_MS, 1000);
});

test('FALLBACK_POLL_MIN_MS/MAX_MS (KAN-128) - el piso de polling de fallback es 15-30s', () => {
  assert.strictEqual(FALLBACK_POLL_MIN_MS, 15000);
  assert.strictEqual(FALLBACK_POLL_MAX_MS, 30000);
});

test('randomIntervalMs (KAN-128) - siempre cae dentro de [min, max)', () => {
  for (let i = 0; i < 200; i++) {
    const value = randomIntervalMs(FALLBACK_POLL_MIN_MS, FALLBACK_POLL_MAX_MS);
    assert.ok(value >= FALLBACK_POLL_MIN_MS, `${value} debe ser >= ${FALLBACK_POLL_MIN_MS}`);
    assert.ok(value < FALLBACK_POLL_MAX_MS, `${value} debe ser < ${FALLBACK_POLL_MAX_MS}`);
  }
});

test('randomIntervalMs (KAN-128) - produce valores distintos entre llamadas (jitter real, no un valor fijo)', () => {
  const values = new Set();
  for (let i = 0; i < 20; i++) {
    values.add(randomIntervalMs(FALLBACK_POLL_MIN_MS, FALLBACK_POLL_MAX_MS));
  }
  assert.ok(values.size > 1, 'randomIntervalMs no debe devolver siempre el mismo valor.');
});
