/**
 * KAN-128: load test del canal en tiempo real del dashboard (WS + polling de fallback), para
 * validar la meta de 500-1000 usuarios concurrentes ANTES de anunciar el lanzamiento (ver
 * auditoria.md, ítem "no hay test de carga"). Script desechable, pensado para correrlo a mano
 * contra un entorno de staging/prod-like — no corre en CI ni en `npm test`.
 *
 * Abre CONCURRENT_CONNECTIONS conexiones WebSocket reales a /ws (autenticadas con una cookie de
 * sesión real, la misma que usa el dashboard) y, en simultáneo, simula el polling de fallback de
 * cada "usuario" pegándole a GET /api/matches, /api/searches y /api/matches/incoming con el mismo
 * jitter de 15-30s que usa app.js (ver src/dashboard/realtimeMatches.js). Al final imprime un
 * resumen: % de conexiones WS exitosas, latencia de conexión, desconexiones inesperadas durante la
 * corrida, y latencia (avg/p95) + tasa de error de cada endpoint HTTP.
 *
 * Requiere un SESSION_TOKEN real (el valor de la cookie `brokaza_session` de una sesión de tenant
 * ya logueada — abrí el dashboard en el navegador, DevTools > Application > Cookies, copiá el
 * valor). Todas las conexiones simuladas comparten el mismo token: alcanza para medir capacidad de
 * conexión/heartbeat del servidor, no hace falta un tenant real por conexión.
 *
 * Uso:
 *   TARGET_URL=https://staging.brokaza.com SESSION_TOKEN=<token> CONCURRENT_CONNECTIONS=500 \
 *     TEST_DURATION_MS=120000 ts-node scripts/load-test-dashboard.ts
 */
import WebSocket from 'ws';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000';
const SESSION_TOKEN = process.env.SESSION_TOKEN;
const CONCURRENT_CONNECTIONS = Number(process.env.CONCURRENT_CONNECTIONS) || 50;
const TEST_DURATION_MS = Number(process.env.TEST_DURATION_MS) || 30_000;
const HTTP_POLL_MIN_MS = 15_000;
const HTTP_POLL_MAX_MS = 30_000;
const HTTP_ENDPOINTS = ['/api/matches', '/api/searches', '/api/matches/incoming'];

if (!SESSION_TOKEN) {
  console.error('Falta SESSION_TOKEN (cookie brokaza_session de una sesión de tenant real). Ver el comentario de este archivo.');
  process.exit(1);
}

function buildWsUrl(): string {
  const url = new URL(TARGET_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  return url.toString();
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[index];
}

function randomIntervalMs(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

interface WsStats {
  attempted: number;
  connected: number;
  failed: number;
  unexpectedCloses: number;
  connectLatenciesMs: number[];
  unexpectedCloseCodes: Map<number, number>;
}

interface HttpStats {
  requests: number;
  errors: number;
  latenciesMs: number[];
}

const wsStats: WsStats = { attempted: 0, connected: 0, failed: 0, unexpectedCloses: 0, connectLatenciesMs: [], unexpectedCloseCodes: new Map() };
const httpStatsByEndpoint = new Map<string, HttpStats>(HTTP_ENDPOINTS.map((e) => [e, { requests: 0, errors: 0, latenciesMs: [] }]));

function openVirtualWsConnection(index: number): { close: () => void } {
  wsStats.attempted++;
  const startedAt = Date.now();
  const socket = new WebSocket(buildWsUrl(), {
    headers: { Cookie: `brokaza_session=${SESSION_TOKEN}` }
  });

  let openedSuccessfully = false;
  let intentionallyClosed = false;

  socket.on('open', () => {
    openedSuccessfully = true;
    wsStats.connected++;
    wsStats.connectLatenciesMs.push(Date.now() - startedAt);
  });

  // El código de cierre (ej. 4401 = sesión inválida en realtimeHub.ts) es la evidencia clave para
  // distinguir un cierre real de un problema del servidor de uno esperado (fin del test).
  socket.on('close', (code: number) => {
    if (openedSuccessfully && !intentionallyClosed) {
      wsStats.unexpectedCloses++;
      wsStats.unexpectedCloseCodes.set(code, (wsStats.unexpectedCloseCodes.get(code) || 0) + 1);
    }
  });

  socket.on('error', (err) => {
    if (!openedSuccessfully) {
      wsStats.failed++;
      console.error(`[WS ${index}] Error de conexión:`, (err as Error).message);
    }
  });

  return { close: () => { intentionallyClosed = true; socket.close(); } };
}

async function pollHttpEndpointsForVirtualUser(shouldContinue: () => boolean): Promise<void> {
  while (shouldContinue()) {
    await new Promise((resolve) => setTimeout(resolve, randomIntervalMs(HTTP_POLL_MIN_MS, HTTP_POLL_MAX_MS)));
    if (!shouldContinue()) break;

    for (const endpoint of HTTP_ENDPOINTS) {
      const stats = httpStatsByEndpoint.get(endpoint)!;
      const startedAt = Date.now();
      try {
        const res = await fetch(`${TARGET_URL}${endpoint}`, {
          headers: { Cookie: `brokaza_session=${SESSION_TOKEN}` }
        });
        stats.requests++;
        stats.latenciesMs.push(Date.now() - startedAt);
        if (!res.ok) stats.errors++;
      } catch (err) {
        stats.requests++;
        stats.errors++;
      }
    }
  }
}

function printReport(): void {
  const sortedConnectLatencies = wsStats.connectLatenciesMs.slice().sort((a, b) => a - b);
  const avgConnectLatency = sortedConnectLatencies.length
    ? sortedConnectLatencies.reduce((sum, v) => sum + v, 0) / sortedConnectLatencies.length
    : 0;

  console.log('\n========== RESULTADO LOAD TEST — DASHBOARD (KAN-128) ==========');
  console.log(`Conexiones WS intentadas: ${wsStats.attempted}`);
  console.log(`Conexiones WS exitosas:   ${wsStats.connected} (${((wsStats.connected / wsStats.attempted) * 100).toFixed(1)}%)`);
  console.log(`Conexiones WS fallidas:   ${wsStats.failed}`);
  console.log(`Desconexiones inesperadas durante la corrida: ${wsStats.unexpectedCloses}`);
  if (wsStats.unexpectedCloseCodes.size > 0) {
    const codes = Array.from(wsStats.unexpectedCloseCodes.entries()).map(([code, count]) => `${code}: ${count}`).join(', ');
    console.log(`  Códigos de cierre: ${codes}`);
  }
  console.log(`Latencia de conexión WS — avg: ${avgConnectLatency.toFixed(0)}ms, p95: ${percentile(sortedConnectLatencies, 95)}ms`);

  console.log('\n--- Polling HTTP de fallback (simulado por usuario virtual) ---');
  for (const [endpoint, stats] of httpStatsByEndpoint) {
    const sorted = stats.latenciesMs.slice().sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((sum, v) => sum + v, 0) / sorted.length : 0;
    const errorRate = stats.requests ? (stats.errors / stats.requests) * 100 : 0;
    console.log(
      `${endpoint} — requests: ${stats.requests}, errores: ${stats.errors} (${errorRate.toFixed(1)}%), ` +
      `latencia avg: ${avg.toFixed(0)}ms, p95: ${percentile(sorted, 95)}ms`
    );
  }
  console.log('=================================================================\n');
}

async function main(): Promise<void> {
  console.log(`Abriendo ${CONCURRENT_CONNECTIONS} conexiones WS contra ${buildWsUrl()} durante ${TEST_DURATION_MS}ms...`);

  const testEndsAt = Date.now() + TEST_DURATION_MS;
  const shouldContinue = () => Date.now() < testEndsAt;

  const connections = Array.from({ length: CONCURRENT_CONNECTIONS }, (_, i) => openVirtualWsConnection(i));
  const httpPollers = Array.from({ length: CONCURRENT_CONNECTIONS }, () => pollHttpEndpointsForVirtualUser(shouldContinue));

  await Promise.all(httpPollers);
  connections.forEach((c) => c.close());

  // Deja un margen corto para que terminen de llegar los últimos eventos 'close'/'error' antes de reportar.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  printReport();
  process.exit(0);
}

main().catch((err) => {
  console.error('Error inesperado en el load test:', err);
  process.exit(1);
});
