import * as express from 'express';
import { Router } from 'express';
import multer from 'multer';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';
import { createRateLimiter } from '../utils/rateLimit';
import { config } from '../config/env';
import { logger } from '../services/logger';
import * as uploadController from '../controllers/uploadController';

export const uploadRoutes = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // KAN-71: mitigación DoS complementaria al rate limit — sin este límite, memoryStorage()
  // acepta un archivo de cualquier tamaño en memoria del proceso.
  limits: { fileSize: config.uploadMaxFileSizeBytes }
});

// KAN-71: rate limit por tenantId (no por IP) para POST /api/upload y POST /api/upload/confirm-mapping —
// ambos ya están detrás de tenantAuthMiddleware, así que la identidad estable a limitar es el
// tenant, no la IP. Una sola instancia compartida entre ambas rutas (mismo contador).
const uploadRateLimiter = createRateLimiter(config.uploadRateLimitMax, config.uploadRateLimitWindowMs);

function checkUploadRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const tenantId = (req as any).tenantId;
  if (!uploadRateLimiter.check(tenantId)) {
    logger.warn({ tenantId }, `[UPLOAD] Rate limit excedido en ${req.method} ${req.path}`);
    return res.status(429).json({ error: 'Demasiadas subidas de archivo. Esperá un minuto e intentá de nuevo.' });
  }
  next();
}

// KAN-71: upload.single() envuelto a mano (en vez de pasarlo directo como middleware) para
// poder capturar el error de multer si el archivo supera uploadMaxFileSizeBytes y responder
// 413 con un mensaje claro, en vez de dejar que reviente como un 500 genérico sin manejar.
function handleUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
  upload.single('excelFile')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMb = Math.floor(config.uploadMaxFileSizeBytes / (1024 * 1024));
        logger.warn(
          { tenantId: (req as any).tenantId },
          '[UPLOAD] Archivo rechazado: supera el tamaño máximo permitido.'
        );
        return res.status(413).json({ error: `El archivo supera el tamaño máximo permitido (${maxMb}MB).` });
      }
      logger.error({ error: err.message, tenantId: (req as any).tenantId }, '[UPLOAD] Error de multer al procesar el archivo subido');
      return res.status(400).json({ error: 'No se pudo procesar el archivo subido.' });
    }
    next();
  });
}

uploadRoutes.get('/api/upload/mapping-fields', uploadController.getMappingFields);
uploadRoutes.post('/api/upload', tenantAuthMiddleware, checkUploadRateLimit, handleUpload, uploadController.uploadCatalog);
uploadRoutes.post('/api/upload/confirm-mapping', tenantAuthMiddleware, checkUploadRateLimit, handleUpload, uploadController.confirmMapping);
