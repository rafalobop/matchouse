// KAN-128: métricas de rendimiento/latencia del canal en tiempo real del dashboard (WS + polling
// de fallback), extraídas como lógica pura (mismo motivo que realtimeMatches.js — app.js depende
// de document.getElementById de punta a punta y no se puede cargar en Node para testear). Se
// expone como <script> clásico (window.BrokazaDashboardMetrics) y como CommonJS (module.exports).
//
// El estado se pasa explícito (no hay singleton acá) para que sea trivial de testear y para que
// app.js decida cuándo arranca/reinicia una ventana de medición. No mide latencia de red per se
// (el evento del servidor no lleva timestamp, ver realtimeHub.ts) — mide lo que sí es 100%
// observable del lado del cliente: cuántas veces se abrió/cerró el socket, cuántos reintentos de
// reconexión hubo, cuánto tarda el refetch disparado por cada evento WS, y cuántas veces disparó
// el polling de fallback (y si lo hizo con el socket arriba o abajo — si dispara seguido con el
// socket abierto, algo anda mal con el push).
(function (root) {
  const MAX_SAMPLES = 50; // cota simple para no acumular memoria sin límite en una pestaña abierta muchas horas

  function createState() {
    return {
      windowStartedAt: Date.now(),
      socketOpens: 0,
      socketCloses: 0,
      reconnectAttempts: 0,
      refetchDurationsMs: [],
      pollTicksWhileSocketUp: 0,
      pollTicksWhileSocketDown: 0
    };
  }

  function recordSocketOpen(state) {
    state.socketOpens++;
  }

  function recordSocketClose(state) {
    state.socketCloses++;
  }

  function recordReconnectAttempt(state) {
    state.reconnectAttempts++;
  }

  function recordRefetchDuration(state, durationMs) {
    if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs < 0) return;
    state.refetchDurationsMs.push(durationMs);
    if (state.refetchDurationsMs.length > MAX_SAMPLES) {
      state.refetchDurationsMs.shift();
    }
  }

  function recordPollTick(state, isSocketConnected) {
    if (isSocketConnected) {
      state.pollTicksWhileSocketUp++;
    } else {
      state.pollTicksWhileSocketDown++;
    }
  }

  // Percentil simple por interpolación del índice más cercano — alcanza para una muestra chica
  // (<=50 puntos) del lado del cliente, no hace falta un algoritmo de percentiles exacto.
  function percentile(sortedValues, p) {
    if (sortedValues.length === 0) return 0;
    const index = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
    return sortedValues[index];
  }

  function buildSnapshot(state, now) {
    now = now || Date.now();
    const durations = state.refetchDurationsMs.slice().sort((a, b) => a - b);
    const avg = durations.length
      ? durations.reduce((sum, v) => sum + v, 0) / durations.length
      : 0;

    return {
      windowMs: now - state.windowStartedAt,
      socketOpens: state.socketOpens,
      socketCloses: state.socketCloses,
      reconnectAttempts: state.reconnectAttempts,
      refetchSampleCount: durations.length,
      avgRefetchDurationMs: Math.round(avg),
      p95RefetchDurationMs: Math.round(percentile(durations, 95)),
      pollTicksWhileSocketUp: state.pollTicksWhileSocketUp,
      pollTicksWhileSocketDown: state.pollTicksWhileSocketDown,
      timestamp: now
    };
  }

  // Arranca una ventana nueva conservando el mismo objeto de estado (para no perder la referencia
  // que ya tiene app.js) — se llama después de mandar un snapshot al backend.
  function resetWindow(state, now) {
    state.windowStartedAt = now || Date.now();
    state.socketOpens = 0;
    state.socketCloses = 0;
    state.reconnectAttempts = 0;
    state.refetchDurationsMs = [];
    state.pollTicksWhileSocketUp = 0;
    state.pollTicksWhileSocketDown = 0;
  }

  const api = {
    createState,
    recordSocketOpen,
    recordSocketClose,
    recordReconnectAttempt,
    recordRefetchDuration,
    recordPollTick,
    buildSnapshot,
    resetWindow
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.BrokazaDashboardMetrics = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
