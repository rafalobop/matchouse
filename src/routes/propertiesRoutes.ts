import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import * as propertiesController from '../controllers/propertiesController';

// Prefijo /api/catalog/properties (no /api/properties): src/adminRoutes.ts ya registra
// `GET /api/properties` (panel admin, cross-tenant, adminAuthMiddleware) y mountAdminRouter(app) se
// monta antes que las rutas de tenant en src/index.ts — un tenant pegándole a /api/properties
// hubiera caído siempre en la ruta admin (401 por no tener sesión de admin), nunca en esta. Se
// agrupa bajo /api/catalog, mismo dominio que ya usa GET /api/catalog (conteo, ver upload.ts).

export const propertiesRoutes = Router();

propertiesRoutes.get('/api/catalog/properties', tenantAuthMiddleware, propertiesController.listProperties);
propertiesRoutes.post('/api/catalog/properties', tenantAuthMiddleware, propertiesController.createProperty);
propertiesRoutes.patch('/api/catalog/properties/:id', tenantAuthMiddleware, propertiesController.updateProperty);
propertiesRoutes.post('/api/catalog/properties/:id/request_correction', tenantAuthMiddleware, propertiesController.requestCoordinateCorrection);
propertiesRoutes.delete('/api/catalog/properties/:id', tenantAuthMiddleware, propertiesController.deleteProperty);
