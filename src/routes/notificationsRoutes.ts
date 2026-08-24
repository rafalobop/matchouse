import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import * as notificationsController from '../controllers/notificationsController';

export const notificationsRoutes = Router();

notificationsRoutes.get('/api/notifications/vapid-public-key', tenantAuthMiddleware, notificationsController.getVapidPublicKey);
notificationsRoutes.post('/api/notifications/subscribe', tenantAuthMiddleware, notificationsController.subscribe);
