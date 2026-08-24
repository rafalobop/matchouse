// KAN-88: logica pura del socket del contador de matches en tiempo real, extraida de app.js por
// el mismo motivo que ios-onboarding.js (KAN-47) - app.js depende de document.getElementById de
// punta a punta y no se puede cargar en Node para testear con node:test. Se expone como <script>
// clasico (window.BrokazaRealtimeMatches) y como CommonJS (module.exports) para que el mismo
// archivo sirva tal cual al browser y a los tests.
(function (root) {
  const DEFAULT_INITIAL_DELAY_MS = 1000;
  const DEFAULT_MAX_DELAY_MS = 15000;

  // KAN-128: el polling ya no es el mecanismo primario de actualización (eso lo hace el push por
  // WS de arriba) — es la red de seguridad para pestañas sin WS o con el socket caído. Antes corría
  // fijo cada 2-10s por cada uno de los 4 recursos del dashboard (loadMatches/loadCatalogInfo/
  // loadActiveSearches/loadIncomingMatches); a la escala objetivo (500-1000 pestañas abiertas) eso
  // solo era ya, por sí solo, cientos de requests/segundo sostenidos contra el servidor. Se baja el
  // piso a 15-30s.
  const FALLBACK_POLL_MIN_MS = 15000;
  const FALLBACK_POLL_MAX_MS = 30000;

  // Intervalo random dentro de [minMs, maxMs), independiente por cada pestaña/recurso — evita que
  // todas las pestañas abiertas al mismo tiempo (ej. todas reconectando tras una caída del server)
  // polleen en el mismo instante exacto ("thundering herd"), sin necesidad de coordinación entre
  // clientes.
  function randomIntervalMs(minMs, maxMs) {
    return Math.floor(minMs + Math.random() * (maxMs - minMs));
  }

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
    FALLBACK_POLL_MIN_MS,
    FALLBACK_POLL_MAX_MS,
    buildMatchCountSocketUrl,
    shouldRefetchOnMessage,
    nextReconnectDelayMs,
    randomIntervalMs
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.BrokazaRealtimeMatches = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
