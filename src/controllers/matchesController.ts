import * as express from 'express';
import { logger } from '../services/logger';
import { mapBlindMatchRowToDashboardShape, mapIncomingMatchRowToDashboardShape } from '../utils/blindMatchPersistence';

// KAN-78: reescrito contra blind_matches (reemplaza a match_queue, eliminada). Sin fallback a
// coordinator — ese fallback era un Map en memoria permanentemente vacío (nada lo poblaba desde
// el retiro de WhatsApp); ante un error real de DB ahora se responde 500 en vez de degradar en
// silencio a una lista vacía.
export async function listMatches(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const supabase = (req as any).supabaseClient;
  try {
    const { data: dbMatches, error } = await supabase
      .from('blind_matches')
      .select('id, created_at, raw_search_text, property_snapshot, score, reasons, user_review_status, feedback_reason')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const mappedMatches = (dbMatches || []).map(mapBlindMatchRowToDashboardShape);

    res.json({ matches: mappedMatches });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[MATCHES] Error al recuperar matches de blind_matches');
    res.status(500).json({ error: error.message || 'Error interno al recuperar matches.' });
  }
}

// KAN-78: nuevo — dirección recíproca de GET /api/matches. Le permite al dueño de una propiedad
// matcheada ver quién la buscó (nombre/teléfono/inmobiliaria, congelados en searcher_snapshot al
// momento del match), habilitado por la policy RLS de solo lectura "blind_matches_matched_tenant_read"
// (matched_tenant_id = auth.uid()). Solo lectura: la curación (user_review_status/feedback_reason)
// sigue siendo exclusiva del buscador vía POST /api/matches/:id/feedback.
export async function listIncomingMatches(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const supabase = (req as any).supabaseClient;
  try {
    const { data: dbMatches, error } = await supabase
      .from('blind_matches')
      .select('id, created_at, raw_search_text, property_snapshot, searcher_snapshot, score, reasons')
      .eq('matched_tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const mappedMatches = (dbMatches || []).map(mapIncomingMatchRowToDashboardShape);

    res.json({ matches: mappedMatches });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[MATCHES] Error al recuperar matches entrantes de blind_matches');
    res.status(500).json({ error: error.message || 'Error interno al recuperar matches entrantes.' });
  }
}

export async function submitFeedback(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;
  const { status, reason } = req.body;
  const supabase = (req as any).supabaseClient;

  if (!status || !['ACCEPTED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'El estado debe ser ACCEPTED o REJECTED' });
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
    console.error('Error al actualizar el feedback de match:', error);
    res.status(500).json({ error: error.message || 'Error interno al guardar feedback.' });
  }
}
