import { Router } from 'express';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import * as profileController from '../controllers/profileController';

export const profileRoutes = Router();

// ==========================================
// ENDPOINTS DE PERFIL DE TENANT (KAN-64)
// ==========================================
// Con el retiro de WhatsApp/Baileys como canal de entrada, el agente inmobiliario completa su
// perfil (telefono, inmobiliaria, ciudad, pais) despues del magic link, no via WhatsApp OTP.

profileRoutes.get('/api/localities/tucuman', tenantAuthMiddleware, profileController.getTucumanLocalitiesHandler);
profileRoutes.get('/api/profile', tenantAuthMiddleware, profileController.getProfile);
profileRoutes.post('/api/profile', tenantAuthMiddleware, profileController.updateProfile);
