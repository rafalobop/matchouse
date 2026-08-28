import { Router } from 'express';
import { createRateLimiter } from '../utils/rateLimit';
import { getClientIp } from '../utils/getClientIp';
import { logger } from '../services/logger';
import * as authController from '../controllers/authController';

export const authRoutes = Router();

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN (PÚBLICOS)
// ==========================================

// KAN-82: dos limiters en memoria independientes para /api/auth/request-magic-link, en paralelo
// (no en reemplazo uno del otro) — por IP (protege contra un solo origen martillando el
// endpoint) y por email normalizado (protege la bandeja de entrada de una persona puntual,
// independientemente de desde dónde se solicite; dos agentes en la misma oficina/WiFi ya no se
// bloquean entre sí por las solicitudes de uno solo). Antes era 5 req/min solo por IP.
const authIpRateLimiter = createRateLimiter(10, 10 * 60_000);
const authEmailRateLimiter = createRateLimiter(10, 10 * 60_000);

authRoutes.get('/api/auth/session', authController.getSession);

authRoutes.post('/api/auth/request-magic-link', (req, res, next) => {
  const ip = getClientIp(req);
  if (!authIpRateLimiter.check(ip)) {
    logger.warn({ ip, email: req.body?.email }, '[AUTH] Rate limit por IP excedido en solicitud de magic link');
    return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.' });
  }

  // Normalizado (lowercase + trim) para que "Juan@X.com" y " juan@x.com " compartan cupo. Si el
  // body ni siquiera trae un string en `email`, no hay nada que normalizar acá — el controller ya
  // responde 400 sin haber gastado ninguna cuota real (ni Supabase ni email enviado).
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;
  if (email && !authEmailRateLimiter.check(email)) {
    logger.warn({ ip, email }, '[AUTH] Rate limit por email excedido en solicitud de magic link');
    return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.' });
  }

  next();
}, authController.requestMagicLink);

authRoutes.post('/api/auth/exchange-token', authController.exchangeToken);

authRoutes.post('/api/auth/logout', authController.logout);
