// KAN-88: logica pura del socket del contador de matches en tiempo real, extraida de app.js por
// el mismo motivo que ios-onboarding.js (KAN-47) - app.js depende de document.getElementById de
// punta a punta y no se puede cargar en Node para testear con node:test. Se expone como <script>
// clasico (window.BrokazaRealtimeMatches) y como CommonJS (module.exports) para que el mismo
// archivo sirva tal cual al browser y a los tests.
(function (root) {
  const DEFAULT_INITIAL_DELAY_MS = 1000;
  const DEFAULT_MAX_DELAY_MS = 15000;

  function buildMatchCountSocketUrl(location) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  // Decide si un mensaje entrante del WS debe disparar un refetch del contador de matches.
  // Nunca confia en datos del payload mas alla del `type` - el evento real
  // (src/services/realtimeHub.ts) es intencionalmente liviano y sin datos de negocio, así que
  // esta función solo necesita reconocer el tipo de evento, no interpretar nada más.
  function shouldRefetchOnMessage(rawData) {
    let payload;
    try {
      payload = JSON.parse(rawData);
    } catch (error) {
      return false;
    }
    return !!payload && payload.type === 'match_count_changed';
  }

  // Backoff exponencial acotado - cada reconexion fallida duplica la espera hasta el tope, para
  // no insistir agresivamente si el servidor esta caido ni tampoco tardar demasiado en recuperar
  // el canal en vivo cuando vuelve.
  function nextReconnectDelayMs(currentDelayMs, maxDelayMs) {
    maxDelayMs = maxDelayMs || DEFAULT_MAX_DELAY_MS;
    return Math.min(currentDelayMs * 2, maxDelayMs);
  }

  const api = {
    DEFAULT_INITIAL_DELAY_MS,
    DEFAULT_MAX_DELAY_MS,
    buildMatchCountSocketUrl,
    shouldRefetchOnMessage,
    nextReconnectDelayMs
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.BrokazaRealtimeMatches = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
