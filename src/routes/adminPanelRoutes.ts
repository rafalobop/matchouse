import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import * as adminPanelController from '../controllers/adminPanelController';

export const adminPanelRoutes = Router();

// ==========================================
// PANEL DE ADMINISTRACIÓN DE AGENCIA (KAN-306)
// ==========================================
// El gate de "solo dueños" se resuelve dentro de cada controller (requireOwner) contra
// profiles.role — no acá como middleware separado, porque ya necesita el mismo query que hace
// falta para el resto de la lógica de cada handler.

adminPanelRoutes.get('/api/admin-panel/collaborators', tenantAuthMiddleware, adminPanelController.listCollaborators);
adminPanelRoutes.post('/api/admin-panel/collaborators', tenantAuthMiddleware, adminPanelController.inviteCollaborator);
adminPanelRoutes.delete('/api/admin-panel/collaborators/:id', tenantAuthMiddleware, adminPanelController.revokeCollaborator);
adminPanelRoutes.post('/api/admin-panel/collaborators/:id/reactivate', tenantAuthMiddleware, adminPanelController.reactivateCollaborator);
