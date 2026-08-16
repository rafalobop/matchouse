import express from 'express';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { isValidUUID } from '../utils/idValidation';
import { isValidInternalWebhookSecret } from '../utils/internalWebhookAuth';
import { sanitizeMetricNumber } from '../utils/dashboardMetrics';
import { processPropertyUploaded } from '../services/propertyMatchWebhook';
import { createDistributedRateLimiter } from '../utils/rateLimit';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';

// KAN-142: endpoints de infraestructura/observabilidad y el webhook interno de matching
// cartera→búsqueda, extraídos de src/index.ts. Es el único dominio que mezcla rutas públicas
// (config-status), autenticadas por tenant (dashboard-metrics) y autenticadas por secreto
// compartido (webhook interno de Postgres) — no encajan en ningún otro dominio de negocio.

// KAN-128: rate limiter por tenant para POST /api/dashboard-metrics — el cliente manda un snapshot
// cada 60s mientras el dashboard está abierto (ver reportDashboardMetrics en app.js), así que 6
// req/min por tenant deja margen de sobra para algún reintento sin abrir la puerta a floodear los
// logs desde un tenant comprometido/con un bug de reporte en loop.
const dashboardMetricsRateLimiter = createDistributedRateLimiter('dashboard-metrics', 6, 60_000);

const router = express.Router();

// KAN-122: público y sin dependencia de Supabase a propósito — es justamente lo que el frontend
// consulta para saber si Supabase está mal configurado (ALLOW_MISSING_SUPABASE_CREDENTIALS=true
// en desarrollo) antes de intentar cualquier otra cosa. En el caso normal (todas las credenciales
// presentes) devuelve una lista vacía y el dashboard sigue su flujo de siempre.
router.get('/api/system/config-status', (req, res) => {
  res.json({ missingSupabaseCredentials: config.missingSupabaseCredentials });
});

// KAN-128: recibe cada ~60s un snapshot de métricas de rendimiento/latencia del canal en tiempo
// real del dashboard (WS + polling de fallback, ver src/dashboard/metrics.js). No hay APM en la
// infraestructura actual del proyecto (ver auditoria.md), así que el destino de estas métricas es,
// a propósito, el logger estructurado (Pino) — quedan consultables como cualquier otro log en
// Railway/Sentry sin agregar una dependencia nueva de infraestructura.
router.post('/api/dashboard-metrics', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;

  if (!(await dashboardMetricsRateLimiter.check(tenantId))) {
    // 204 en vez de 429: perder un reporte de métricas no debe generar ruido de error visible en
    // el cliente ni reintentos — el próximo snapshot (60s después) lo compensa.
    return res.status(204).end();
  }

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
});

// KAN-79: endpoint interno SIN sesión de usuario — lo llama el trigger de Postgres
// (property_uploaded_trigger, AFTER INSERT ON properties) vía pg_net cuando entra una propiedad
// nueva, para la dirección cartera→búsqueda del matching bidireccional (complementaria a
// POST /api/search, que ya cubre búsqueda→cartera). No usa tenantAuthMiddleware porque no hay JWT
// de tenant en esta llamada — se protege con un secreto compartido en vez de una sesión.
router.post('/internal/property-match-check', async (req, res) => {
  const providedSecret = req.header('x-internal-secret');
  if (!isValidInternalWebhookSecret(providedSecret, config.internalWebhookSecret)) {
    logger.warn('[PROPERTY MATCH WEBHOOK] Intento de acceso sin secreto válido a /internal/property-match-check.');
    return res.status(401).json({ error: 'No autorizado.' });
  }

  const { property_id } = req.body;
  if (!isValidUUID(property_id)) {
    return res.status(400).json({ error: 'property_id inválido.' });
  }

  try {
    const result = await processPropertyUploaded(property_id);
    res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    logger.error({ error: error.message || error, propertyId: property_id }, '[PROPERTY MATCH WEBHOOK] Error al procesar el matching cartera→búsqueda.');
    res.status(500).json({ error: 'Error interno al procesar el matching.' });
  }
});

export default router;
