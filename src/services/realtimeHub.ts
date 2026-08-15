// KAN-88: hub de WebSockets del dashboard. Complementa (no reemplaza) el polling existente de
// GET /api/searches (cada 10s, KAN-42): cuando se persiste un match nuevo (búsqueda→cartera en
// POST /api/search, o cartera→búsqueda en propertyMatchWebhook.ts/KAN-79), se empuja un evento
// "match_count_changed" a los sockets abiertos del/los tenant(s) afectado(s) para que el
// contador de "X matches" se actualice sin esperar al próximo poll. El polling sigue activo como
// red de seguridad (reconexión, pestañas sin WS, etc.) — el evento WS solo dispara un refetch
// inmediato en el frontend, nunca reemplaza el dato de la base.
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { supabase as serviceRoleSupabase } from './supabase';
import { logger } from './logger';

export type GetUserFn = (token: string) => Promise<{ data: { user: { id: string } | null }; error: any }>;

// KAN-128: intervalo del heartbeat ping/pong. A la escala objetivo (500-1000 tenants con el
// dashboard abierto) una conexión "medio caída" (el proceso remoto murió o el cable se cortó sin
// un cierre TCP limpio) nunca dispara 'close'/'error' por sí sola — quedaría registrada para
// siempre en `tenantSockets`, acumulando sockets muertos y, peor, haciendo que el cliente crea que
// tiene un canal en vivo cuando en realidad no recibe nada (nunca reconecta porque nunca ve un
// 'close'). El ping/pong estándar de WebSocket (RFC 6455, ambos navegadores y el cliente `ws` lo
// responden automáticamente a nivel de protocolo, sin código en app.js) detecta esto de forma
// activa en como mucho 2x este intervalo.
export const HEARTBEAT_INTERVAL_MS = 25_000;

const tenantSockets = new Map<string, Set<WebSocket>>();

export function registerSocket(tenantId: string, socket: WebSocket): void {
  let sockets = tenantSockets.get(tenantId);
  if (!sockets) {
    sockets = new Set();
    tenantSockets.set(tenantId, sockets);
  }
  sockets.add(socket);
}

export function unregisterSocket(tenantId: string, socket: WebSocket): void {
  const sockets = tenantSockets.get(tenantId);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) tenantSockets.delete(tenantId);
}

export function connectedTenantCount(): number {
  return tenantSockets.size;
}

/**
 * Avisa a todos los sockets abiertos de cada tenant en `tenantIds` que el conteo de matches
 * pudo haber cambiado. Dedupea tenants repetidos (un property upload puede generar varios
 * matches para el mismo tenant) para no mandar el mismo evento más de una vez por llamada.
 */
export function broadcastMatchCountChanged(tenantIds: Iterable<string>): void {
  const seen = new Set<string>();
  const payload = JSON.stringify({ type: 'match_count_changed' });

  for (const tenantId of tenantIds) {
    if (!tenantId || seen.has(tenantId)) continue;
    seen.add(tenantId);

    const sockets = tenantSockets.get(tenantId);
    if (!sockets || sockets.size === 0) continue;

    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(payload);
      } catch (err: any) {
        logger.error({ error: err.message || err, tenantId }, '[REALTIME] Error al enviar evento WS a un socket.');
      }
    }
  }
}

/**
 * Barrido de heartbeat: marca "muerto" (y termina) cualquier socket que no contestó el ping
 * anterior con un pong, y pinguea a todos los que siguen vivos para el próximo ciclo. Recibe los
 * sockets como iterable en vez de tomar el `WebSocketServer` directamente para poder testearlo con
 * sockets falsos sin depender de `wss.clients` (que solo se puebla con upgrades TCP reales).
 */
export function runHeartbeatSweep(sockets: Iterable<WebSocket>): void {
  for (const socket of sockets as Iterable<WebSocket & { isAlive?: boolean; terminate?: () => void; ping?: () => void }>) {
    if (socket.isAlive === false) {
      socket.terminate?.();
      continue;
    }
    socket.isAlive = false;
    socket.ping?.();
  }
}

function extractSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const found = cookieHeader
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('brokaza_session='));
  if (!found) return null;
  return decodeURIComponent(found.slice('brokaza_session='.length));
}

/**
 * Arranca el WebSocketServer sobre el mismo servidor HTTP de Express, en /ws. Autentica el
 * handshake con la misma cookie de sesión que tenantAuthMiddleware (`brokaza_session`) — no hay
 * JWT propio de tenant en el upgrade request, así que se valida contra Supabase Auth igual que
 * cualquier request REST autenticado.
 */
export function initRealtimeHub(server: HttpServer, getUser: GetUserFn = (token) => serviceRoleSupabase.auth.getUser(token)): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (socket: WebSocket, req: IncomingMessage) => {
    const token = extractSessionToken(req.headers.cookie);
    if (!token) {
      socket.close(4401, 'No autenticado.');
      return;
    }

    let tenantId: string | null = null;
    try {
      const { data, error } = await getUser(token);
      if (error || !data?.user) {
        socket.close(4401, 'Sesión inválida o expirada.');
        return;
      }
      tenantId = data.user.id;
    } catch (err: any) {
      logger.error({ error: err.message || err }, '[REALTIME] Error al autenticar la conexión WS.');
      socket.close(1011, 'Error interno.');
      return;
    }

    registerSocket(tenantId, socket);
    (socket as any).isAlive = true;
    socket.on('pong', () => {
      (socket as any).isAlive = true;
    });

    socket.on('close', () => {
      unregisterSocket(tenantId as string, socket);
    });

    socket.on('error', (err: any) => {
      logger.error({ error: err.message || err, tenantId }, '[REALTIME] Error en un socket WS ya autenticado.');
    });
  });

  const heartbeatInterval = setInterval(() => runHeartbeatSweep(wss.clients), HEARTBEAT_INTERVAL_MS);
  // unref(): este timer no debe mantener vivo el proceso por sí solo (mismo criterio que el
  // barrido periódico de tenantClientsCache en supabase.ts).
  heartbeatInterval.unref?.();
  wss.on('close', () => clearInterval(heartbeatInterval));

  return wss;
}
