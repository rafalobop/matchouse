import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import * as matchesController from '../controllers/matchesController';

export const matchesRoutes = Router();

matchesRoutes.get('/api/matches', tenantAuthMiddleware, matchesController.listMatches);
matchesRoutes.get('/api/matches/incoming', tenantAuthMiddleware, matchesController.listIncomingMatches);
matchesRoutes.post('/api/matches/:id/feedback', tenantAuthMiddleware, matchesController.submitFeedback);
