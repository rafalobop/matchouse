import * as express from 'express';
import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import { createRateLimiter } from '../utils/rateLimit';
import { logger } from '../services/logger';
import * as systemController from '../controllers/systemController';

// KAN-76: GET /api/system/config-status y POST /api/dashboard-metrics vivían solo en el
// src/routes/system.ts viejo (KAN-142), nunca montado tras el split a routes/*Routes.ts +
// controllers/* (commit "add: new routes structure", 2026-08-24) — mismo patrón de bug ya
// documentado para GET/POST/PATCH/DELETE /api/catalog/properties (ver KAN-273 en routes/index.ts).

export const systemRoutes = Router();

// KAN-128: 6 req/min por tenant — el cliente manda un snapshot cada 60s mientras el dashboard
// está abierto, así que deja margen de sobra para algún reintento sin abrir la puerta a floodear
// los logs desde un tenant comprometido/con un bug de reporte en loop.
const dashboardMetricsRateLimiter = createRateLimiter(6, 60_000);

function checkDashboardMetricsRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const tenantId = req.tenantId;
  if (!dashboardMetricsRateLimiter.check(tenantId)) {
    // 204 en vez de 429: perder un reporte de métricas no debe generar ruido de error visible en
    // el cliente ni reintentos — el próximo snapshot (60s después) lo compensa.
    logger.warn({ tenantId }, '[DASHBOARD METRICS] Rate limit excedido en POST /api/dashboard-metrics');
    return res.status(204).end();
  }
  next();
}

systemRoutes.get('/api/system/config-status', systemController.getConfigStatus);
systemRoutes.post('/api/dashboard-metrics', tenantAuthMiddleware, checkDashboardMetricsRateLimit, systemController.reportDashboardMetrics);
