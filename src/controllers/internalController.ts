import * as express from 'express';
import { isValidInternalWebhookSecret } from '../utils/internalWebhookAuth';
import { isValidUUID } from '../utils/idValidation';
import { processPropertyUploaded } from '../services/propertyMatchWebhook';
import { config } from '../config/env';
import { logger } from '../services/logger';

// KAN-79: endpoint interno SIN sesión de usuario — lo llama el trigger de Postgres
// (property_uploaded_trigger, AFTER INSERT ON properties) vía pg_net cuando entra una propiedad
// nueva, para la dirección cartera→búsqueda del matching bidireccional (complementaria a
// POST /api/search, que ya cubre búsqueda→cartera). No usa tenantAuthMiddleware porque no hay JWT
// de tenant en esta llamada — se protege con un secreto compartido en vez de una sesión.
export async function propertyMatchCheck(req: express.Request, res: express.Response) {
  const providedSecret = req.header('x-internal-secret');
  if (!isValidInternalWebhookSecret(providedSecret, config.internalWebhookSecret)) {
    logger.warn('[PROPERTY MATCH WEBHOOK] Intento de acceso sin secreto válido a /internal/property-match-check.');
    return res.status(401).json({ error: 'No autorizado.' });
  }

  const { property_id } = req.body;
  if (!isValidUUID(property_id)) {
    return res.status(400).json({ error: 'property_id inválido.' });
  }

  try {
    const result = await processPropertyUploaded(property_id);
    res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    logger.error({ error: error.message || error, propertyId: property_id }, '[PROPERTY MATCH WEBHOOK] Error al procesar el matching cartera→búsqueda.');
    res.status(500).json({ error: 'Error interno al procesar el matching.' });
  }
}
