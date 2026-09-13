import * as express from 'express';
import { logger } from '../services/logger';
import { mapBlindMatchRowToDashboardShape, mapIncomingMatchRowToDashboardShape } from '../utils/blindMatchPersistence';
import { parsePagination } from '../utils/pagination';
import { isValidUUID } from '../utils/idValidation';
import { validateBodyWhitelist } from '../utils/bodyWhitelist';

const FEEDBACK_REASON_MAX_LENGTH = 500;

// KAN-291: antes ambos endpoints tenían `.limit(50)` fijo, sin `offset` — un tenant con más de 50
// matches históricos jamás podía ver los más viejos, sin ningún error ni indicio de que había más
// datos. Mismo criterio (limit/offset + total) que ya usa GET /api/catalog/properties
// (src/controllers/propertiesController.ts) para el resto de las listas paginadas del dashboard de tenant.

// KAN-78: reescrito contra blind_matches (reemplaza a match_queue, eliminada). Sin fallback a
// coordinator — ese fallback era un Map en memoria permanentemente vacío (nada lo poblaba desde
// el retiro de WhatsApp); ante un error real de DB ahora se responde 500 en vez de degradar en
// silencio a una lista vacía.
export async function listMatches(req: express.Request, res: express.Response) {
  const tenantId = req.tenantId;
  const supabase = req.supabaseClient;

  const { limit, offset, error: paginationError } = parsePagination(req.query);
  if (paginationError) {
    return res.status(400).json({ error: paginationError });
  }

  try {
    const { data: dbMatches, error, count } = await supabase
      .from('blind_matches')
      .select('id, created_at, raw_search_text, property_snapshot, score, reasons, user_review_status, feedback_reason', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const mappedMatches = (dbMatches || []).map(mapBlindMatchRowToDashboardShape);

    res.json({ matches: mappedMatches, total: count ?? 0, limit, offset });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[MATCHES] Error al recuperar matches de blind_matches');
    res.status(500).json({ error: 'Error interno al recuperar matches.' });
  }
}

// KAN-78: nuevo — dirección recíproca de GET /api/matches. Le permite al dueño de una propiedad
// matcheada ver quién la buscó (nombre/teléfono/inmobiliaria, congelados en searcher_snapshot al
// momento del match), habilitado por la policy RLS de solo lectura "blind_matches_matched_tenant_read"
// (matched_tenant_id = auth.uid()). Solo lectura: la curación (user_review_status/feedback_reason)
// sigue siendo exclusiva del buscador vía POST /api/matches/:id/feedback.
export async function listIncomingMatches(req: express.Request, res: express.Response) {
  const tenantId = req.tenantId;
  const supabase = req.supabaseClient;

  const { limit, offset, error: paginationError } = parsePagination(req.query);
  if (paginationError) {
    return res.status(400).json({ error: paginationError });
  }

  try {
    const { data: dbMatches, error, count } = await supabase
      .from('blind_matches')
      .select('id, created_at, raw_search_text, property_snapshot, searcher_snapshot, score, reasons', { count: 'exact' })
      .eq('matched_tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const mappedMatches = (dbMatches || []).map(mapIncomingMatchRowToDashboardShape);

    res.json({ matches: mappedMatches, total: count ?? 0, limit, offset });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[MATCHES] Error al recuperar matches entrantes de blind_matches');
    res.status(500).json({ error: 'Error interno al recuperar matches entrantes.' });
  }
}

export async function submitFeedback(req: express.Request, res: express.Response) {
  const tenantId = req.tenantId;
  const id = req.params.id as string;
  const { status, reason } = req.body;
  const supabase = req.supabaseClient;

  const bodyWhitelistError = validateBodyWhitelist(req.body, ['status', 'reason']);
  if (bodyWhitelistError) {
    return res.status(400).json({ error: bodyWhitelistError });
  }

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'El ID del match está mal formado.' });
  }

  if (!status || !['ACCEPTED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'El estado debe ser ACCEPTED o REJECTED' });
  }

  if (reason !== undefined && (typeof reason !== 'string' || reason.length > FEEDBACK_REASON_MAX_LENGTH)) {
    return res.status(400).json({ error: `El motivo no puede superar los ${FEEDBACK_REASON_MAX_LENGTH} caracteres.` });
  }

  try {
    const { data, error } = await supabase
      .from('blind_matches')
      .update({
        user_review_status: status,
        feedback_reason: status === 'REJECTED' ? (reason || 'No especificado') : null
      })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id');

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Match no encontrado.' });
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ tenantId, matchId: id, err: error.message || error }, '[MATCHES] Error al actualizar el feedback de match');
    res.status(500).json({ error: 'Error interno al guardar feedback.' });
  }
}
