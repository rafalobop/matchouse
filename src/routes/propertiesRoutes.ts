import * as express from 'express';
import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import { createRateLimiter } from '../utils/rateLimit';
import { config } from '../config/env';
import { logger } from '../services/logger';
import * as propertiesController from '../controllers/propertiesController';

// Prefijo /api/catalog/properties (no /api/properties): src/adminRoutes.ts ya registra
// `GET /api/properties` (panel admin, cross-tenant, adminAuthMiddleware) y mountAdminRouter(app) se
// monta antes que las rutas de tenant en src/index.ts — un tenant pegándole a /api/properties
// hubiera caído siempre en la ruta admin (401 por no tener sesión de admin), nunca en esta. Se
// agrupa bajo /api/catalog, mismo dominio que ya usa GET /api/catalog (conteo, ver upload.ts).

export const propertiesRoutes = Router();

// A diferencia de /api/search y /api/upload, el alta/edición manual no dispara IA — pero seguía
// sin ningún freno de cadencia (solo el cap de cantidad total del plan). Rate limit en memoria por
// tenantId, mismo patrón que searchRoutes.ts, aplicado solo a los endpoints de escritura.
const propertiesRateLimiter = createRateLimiter(config.propertiesRateLimitMax, config.propertiesRateLimitWindowMs);

function checkPropertiesRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const tenantId = req.tenantId;
  if (!propertiesRateLimiter.check(tenantId)) {
    logger.warn({ tenantId }, `[PROPERTIES] Rate limit excedido en ${req.method} ${req.path}`);
    return res.status(429).json({ error: 'Demasiadas modificaciones de propiedades. Esperá un minuto e intentá de nuevo.' });
  }
  next();
}

propertiesRoutes.get('/api/catalog/properties', tenantAuthMiddleware, propertiesController.listProperties);
propertiesRoutes.post('/api/catalog/properties', tenantAuthMiddleware, checkPropertiesRateLimit, propertiesController.createProperty);
propertiesRoutes.patch('/api/catalog/properties/:id', tenantAuthMiddleware, checkPropertiesRateLimit, propertiesController.updateProperty);
propertiesRoutes.post('/api/catalog/properties/:id/request_correction', tenantAuthMiddleware, propertiesController.requestCoordinateCorrection);
propertiesRoutes.delete('/api/catalog/properties/:id', tenantAuthMiddleware, propertiesController.deleteProperty);
