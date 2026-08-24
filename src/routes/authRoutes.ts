import { Router } from 'express';
import { createRateLimiter } from '../utils/rateLimit';
import { getClientIp } from '../utils/getClientIp';
import { logger } from '../services/logger';
import * as authController from '../controllers/authController';

export const authRoutes = Router();

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN (PÚBLICOS)
// ==========================================

// Rate limiter en memoria para endpoints de auth (max 5 req/min por IP)
const authRateLimiter = createRateLimiter(5, 60_000);

authRoutes.get('/api/auth/session', authController.getSession);

authRoutes.post('/api/auth/request-magic-link', (req, res, next) => {
  const ip = getClientIp(req);
  if (!authRateLimiter.check(ip)) {
    logger.warn({ ip, email: req.body?.email }, '[AUTH] Rate limit excedido en solicitud de magic link');
    return res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto e intentá de nuevo.' });
  }
  next();
}, authController.requestMagicLink);

authRoutes.post('/api/auth/exchange-token', authController.exchangeToken);

authRoutes.post('/api/auth/logout', authController.logout);
