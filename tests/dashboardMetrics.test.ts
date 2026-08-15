import test from 'node:test';
import assert from 'node:assert';
import * as path from 'path';

// metrics.js es un script de browser plano (sin tipos ni allowJs habilitado en tsconfig), se carga
// con require() en vez de import por el mismo motivo que realtimeMatches.js (ver ese test).
const {
  createState,
  recordSocketOpen,
  recordSocketClose,
  recordReconnectAttempt,
  recordRefetchDuration,
  recordPollTick,
  buildSnapshot,
  resetWindow
} = require(path.join('..', 'src', 'dashboard', 'metrics'));

test('createState (KAN-128) - arranca en cero', () => {
  const state = createState();
  const snapshot = buildSnapshot(state, state.windowStartedAt);
  assert.strictEqual(snapshot.socketOpens, 0);
  assert.strictEqual(snapshot.socketCloses, 0);
  assert.strictEqual(snapshot.reconnectAttempts, 0);
  assert.strictEqual(snapshot.refetchSampleCount, 0);
  assert.strictEqual(snapshot.avgRefetchDurationMs, 0);
  assert.strictEqual(snapshot.p95RefetchDurationMs, 0);
  assert.strictEqual(snapshot.pollTicksWhileSocketUp, 0);
  assert.strictEqual(snapshot.pollTicksWhileSocketDown, 0);
});

test('recordSocketOpen/Close (KAN-128) - cuentan aperturas y cierres por separado', () => {
  const state = createState();
  recordSocketOpen(state);
  recordSocketOpen(state);
  recordSocketClose(state);

  const snapshot = buildSnapshot(state);
  assert.strictEqual(snapshot.socketOpens, 2);
  assert.strictEqual(snapshot.socketCloses, 1);
});

test('recordReconnectAttempt (KAN-128) - cuenta intentos de reconexión', () => {
  const state = createState();
  recordReconnectAttempt(state);
  recordReconnectAttempt(state);
  recordReconnectAttempt(state);

  assert.strictEqual(buildSnapshot(state).reconnectAttempts, 3);
});

test('recordRefetchDuration (KAN-128) - calcula promedio y p95 sobre las muestras', () => {
  const state = createState();
  [10, 20, 30, 40, 100].forEach((ms) => recordRefetchDuration(state, ms));

  const snapshot = buildSnapshot(state);
  assert.strictEqual(snapshot.refetchSampleCount, 5);
  assert.strictEqual(snapshot.avgRefetchDurationMs, 40); // (10+20+30+40+100)/5 = 40
  assert.strictEqual(snapshot.p95RefetchDurationMs, 100);
});

test('recordRefetchDuration (KAN-128) - ignora valores no numéricos o negativos', () => {
  const state = createState();
  recordRefetchDuration(state, -5);
  recordRefetchDuration(state, NaN);
  recordRefetchDuration(state, 'no es un número');
  recordRefetchDuration(state, undefined);

  assert.strictEqual(buildSnapshot(state).refetchSampleCount, 0);
});

test('recordRefetchDuration (KAN-128) - acota la cantidad de muestras guardadas (no crece sin límite)', () => {
  const state = createState();
  for (let i = 0; i < 200; i++) recordRefetchDuration(state, i);

  assert.ok(state.refetchDurationsMs.length <= 50, 'No debe acumular más de 50 muestras.');
});

test('recordPollTick (KAN-128) - distingue polls de fallback con el socket arriba vs. abajo', () => {
  const state = createState();
  recordPollTick(state, true);
  recordPollTick(state, true);
  recordPollTick(state, false);

  const snapshot = buildSnapshot(state);
  assert.strictEqual(snapshot.pollTicksWhileSocketUp, 2);
  assert.strictEqual(snapshot.pollTicksWhileSocketDown, 1);
});

test('buildSnapshot (KAN-128) - windowMs refleja el tiempo transcurrido desde el inicio de la ventana', () => {
  const state = createState();
  const snapshot = buildSnapshot(state, state.windowStartedAt + 60000);
  assert.strictEqual(snapshot.windowMs, 60000);
});

test('resetWindow (KAN-128) - vuelve todos los contadores a cero y arranca una ventana nueva', () => {
  const state = createState();
  recordSocketOpen(state);
  recordSocketClose(state);
  recordReconnectAttempt(state);
  recordRefetchDuration(state, 50);
  recordPollTick(state, true);

  const resetAt = state.windowStartedAt + 60000;
  resetWindow(state, resetAt);

  const snapshot = buildSnapshot(state, resetAt);
  assert.strictEqual(snapshot.socketOpens, 0);
  assert.strictEqual(snapshot.socketCloses, 0);
  assert.strictEqual(snapshot.reconnectAttempts, 0);
  assert.strictEqual(snapshot.refetchSampleCount, 0);
  assert.strictEqual(snapshot.pollTicksWhileSocketUp, 0);
  assert.strictEqual(snapshot.windowMs, 0);
});
