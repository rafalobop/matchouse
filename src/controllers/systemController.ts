import * as express from 'express';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { sanitizeMetricNumber } from '../utils/dashboardMetrics';

// KAN-122: público y sin dependencia de Supabase a propósito — es justamente lo que el frontend
// consulta para saber si Supabase está mal configurado (ALLOW_MISSING_SUPABASE_CREDENTIALS=true
// en desarrollo) antes de intentar cualquier otra cosa. En el caso normal (todas las credenciales
// presentes) devuelve una lista vacía y el dashboard sigue su flujo de siempre.
export function getConfigStatus(req: express.Request, res: express.Response) {
  res.json({ missingSupabaseCredentials: config.missingSupabaseCredentials });
}

// KAN-128: recibe cada ~60s un snapshot de métricas de rendimiento/latencia del canal en tiempo
// real del dashboard (WS + polling de fallback). No hay APM en la infraestructura actual del
// proyecto, así que el destino de estas métricas es, a propósito, el logger estructurado (Pino) —
// quedan consultables como cualquier otro log en Railway/Sentry sin agregar una dependencia nueva
// de infraestructura.
export function reportDashboardMetrics(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const body = req.body || {};
  logger.info({
    tenantId,
    windowMs: sanitizeMetricNumber(body.windowMs, 24 * 60 * 60 * 1000),
    socketOpens: sanitizeMetricNumber(body.socketOpens, 1000),
    socketCloses: sanitizeMetricNumber(body.socketCloses, 1000),
    reconnectAttempts: sanitizeMetricNumber(body.reconnectAttempts, 1000),
    refetchSampleCount: sanitizeMetricNumber(body.refetchSampleCount, 1000),
    avgRefetchDurationMs: sanitizeMetricNumber(body.avgRefetchDurationMs, 60_000),
    p95RefetchDurationMs: sanitizeMetricNumber(body.p95RefetchDurationMs, 60_000),
    pollTicksWhileSocketUp: sanitizeMetricNumber(body.pollTicksWhileSocketUp, 1000),
    pollTicksWhileSocketDown: sanitizeMetricNumber(body.pollTicksWhileSocketDown, 1000)
  }, '[DASHBOARD METRICS] Snapshot recibido');

  res.status(204).end();
}
