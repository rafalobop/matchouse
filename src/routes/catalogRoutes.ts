import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import * as catalogController from '../controllers/catalogController';

export const catalogRoutes = Router();

catalogRoutes.get('/api/catalog', tenantAuthMiddleware, catalogController.getCatalogCount);
