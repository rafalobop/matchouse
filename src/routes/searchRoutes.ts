import * as express from 'express';
import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import { createRateLimiter } from '../utils/rateLimit';
import { config } from '../config/env';
import { logger } from '../services/logger';
import * as searchController from '../controllers/searchController';

export const searchRoutes = Router();

// KAN-71: rate limit por tenantId — POST /api/search dispara llamadas pagas a Gemini/OpenAI por
// request (extractFromTextInput, y segmentSearchRequests), así que abuso acá tiene costo real,
// no solo carga de CPU.
const searchRateLimiter = createRateLimiter(config.searchRateLimitMax, config.searchRateLimitWindowMs);

function checkSearchRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const tenantId = (req as any).tenantId;
  if (!searchRateLimiter.check(tenantId)) {
    logger.warn({ tenantId }, '[BUSQUEDA] Rate limit excedido en POST /api/search');
    return res.status(429).json({ error: 'Demasiadas búsquedas. Esperá un minuto e intentá de nuevo.' });
  }
  next();
}

searchRoutes.post('/api/search', tenantAuthMiddleware, checkSearchRateLimit, searchController.createSearch);
searchRoutes.get('/api/searches', tenantAuthMiddleware, searchController.listSearches);
searchRoutes.delete('/api/searches/:id', tenantAuthMiddleware, searchController.archiveSearch);
searchRoutes.post('/api/searches/:id/reactivate', tenantAuthMiddleware, searchController.reactivateSearch);
