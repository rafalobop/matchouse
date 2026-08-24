import * as express from 'express';
import { logger } from '../services/logger';

export async function getCatalogCount(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  try {
    const { count, error } = await tenantSupabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (error: any) {
    logger.error({ tenantId, err: error.message }, '[CATALOGO] Error al contar propiedades del tenant');
    res.status(500).json({ error: 'Error interno al obtener el catálogo.' });
  }
}
