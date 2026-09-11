import * as express from 'express';
import { segmentSearchRequests, ZoneIntentRequest, AITimeoutError, AIExtractionFailedError } from '../services/ai';
import { findCrossTenantMatches } from '../services/blindMatching';
import { validateFreeSearchText } from '../utils/searchValidation';
import { calculateDaysRemaining } from '../utils/activeSearches';
import { isValidUUID } from '../utils/idValidation';
import { supabase } from '../services/supabase';
import { sendWebPushToTenant } from '../services/webPush';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { processSingleSearchSegment, SearchSegmentResult } from '../services/searchSegmentProcessor';
import { getTenantPlanLimits, countTenantSearchesThisMonth } from '../services/planLimits';

// KAN-37: motor de matching bidireccional entre tenants, dirección búsqueda→cartera. Un tenant
// describe lo que busca en texto libre y recibe matches de la cartera de OTROS tenants (excluye
// la propia). Un mismo mensaje puede describir 2+ pedidos independientes — se segmenta primero
// (Agente 0, ver ai.ts#segmentSearchRequests) y cada segmento se procesa por separado, generando
// su propia fila de active_searches y su propio set de matches/notificaciones.
export async function createSearch(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  const { text } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'El texto de búsqueda es requerido.' });
  }

  const validationError = validateFreeSearchText(text);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  if (!config.freeTextExtractionEnabled) {
    return res.status(501).json({ error: 'La búsqueda de texto libre (matching ciego) todavía no está habilitada.' });
  }

  // Fase 1 pre-lanzamiento: cuota mensual de búsquedas del plan (ver src/config/planLimits.ts).
  // Cheque temprano, antes de segmentar, para no gastar la llamada a IA de Agente 0 si ya no queda cuota.
  let maxSearchesPerMonth: number;
  try {
    ({ maxSearchesPerMonth } = await getTenantPlanLimits(tenantId, tenantSupabase));
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[BUSQUEDA] Error al leer límites del plan.');
    return res.status(500).json({ error: 'Error interno al validar el límite de búsquedas de tu plan.' });
  }
  const searchesThisMonth = await countTenantSearchesThisMonth(tenantId, tenantSupabase);
  if (searchesThisMonth >= maxSearchesPerMonth) {
    return res.status(403).json({
      error: `Alcanzaste el límite de ${maxSearchesPerMonth} búsquedas de este mes.`,
      code: 'SEARCH_QUOTA_EXCEEDED'
    });
  }

  let segments: string[];
  try {
    segments = await segmentSearchRequests(text); // Agente 0 — fail-soft, nunca lanza
  } catch (error: any) {
    // Defensivo: aunque segmentSearchRequests no debería lanzar, un fallo acá no debe bloquear
    // el flujo — degradar al mensaje completo como única búsqueda.
    logger.error({ error: error.message || error, tenantId }, '[BUSQUEDA] Error inesperado en segmentación; se procesa como búsqueda única.');
    segments = [text];
  }

  // Un mismo mensaje puede segmentarse en más sub-búsquedas de las que quedan de cuota este mes:
  // se procesan las primeras `remaining` y el resto queda marcado como cuota agotada, sin llegar a
  // pedirle nada a la IA de extracción (Agente 1) para esos segmentos.
  const remaining = maxSearchesPerMonth - searchesThisMonth;
  const segmentsToProcess = segments.slice(0, remaining);
  const segmentsOverQuota = segments.slice(remaining);

  // KAN-279: en paralelo (antes: `for...await` secuencial, ~Nx la latencia de un solo segmento).
  // Cada llamada atrapa su propio error acá adentro (nunca rechaza el `Promise.all` de afuera) —
  // mismo criterio de "un timeout/error puntual no aborta el resto del lote" que ya tenía el catch
  // del loop secuencial, solo que ahora corren concurrentemente en vez de en serie.
  const segmentOutcomes = await Promise.all(
    segmentsToProcess.map(async (segmentText): Promise<{ result: SearchSegmentResult; aiTimeout: boolean; aiExtractionFailed: boolean }> => {
      try {
        const result = await processSingleSearchSegment(tenantId, tenantSupabase, segmentText);
        return { result, aiTimeout: false, aiExtractionFailed: false };
      } catch (error: any) {
        if (error instanceof AITimeoutError) {
          return { result: { success: false, raw_text: segmentText, error: error.message, code: 'AI_TIMEOUT' }, aiTimeout: true, aiExtractionFailed: false };
        }
        // KAN-339: fallo real (no timeout) de AMBAS estrategias de IA al extraer la búsqueda —
        // antes esto no existía como caso distinguible, `extractFromTextInput` degradaba en
        // silencio a criterios comodín y la búsqueda se publicaba igual (ver ai.ts). Mismo
        // tratamiento que AITimeoutError: código distinguible para el cliente, no un 500 genérico.
        if (error instanceof AIExtractionFailedError) {
          return { result: { success: false, raw_text: segmentText, error: error.message, code: 'AI_EXTRACTION_FAILED' }, aiTimeout: false, aiExtractionFailed: true };
        }
        logger.error({ error: error.message || error, tenantId, segmentText }, '[BUSQUEDA] Error al procesar un segmento de búsqueda.');
        return { result: { success: false, raw_text: segmentText, error: 'Error interno al procesar este segmento.' }, aiTimeout: false, aiExtractionFailed: false };
      }
    })
  );

  const results: SearchSegmentResult[] = segmentOutcomes.map(o => o.result);
  const anyAITimeout = segmentOutcomes.some(o => o.aiTimeout);
  const anyAIExtractionFailed = segmentOutcomes.some(o => o.aiExtractionFailed);

  const anyQuotaExceeded = segmentsOverQuota.length > 0;
  for (const segmentText of segmentsOverQuota) {
    results.push({
      success: false,
      raw_text: segmentText,
      error: `Límite mensual de búsquedas alcanzado (${maxSearchesPerMonth}/mes).`,
      code: 'SEARCH_QUOTA_EXCEEDED'
    });
  }

  const allFailed = results.every(r => !r.success);
  const httpStatus = allFailed
    ? (anyAITimeout ? 504 : anyAIExtractionFailed ? 502 : anyQuotaExceeded ? 403 : 500)
    : 200;

  res.status(httpStatus).json({
    success: !allFailed,
    segmented: segments.length > 1,
    searches: results
  });
}

// KAN-39: listado de búsquedas activas propias con conteo de matches cross-tenant. El conteo se
// recalcula en vivo reusando findCrossTenantMatches (mismo motor que POST /api/search) porque el
// matching ciego, por decisión explícita de KAN-37, no persiste los matches cruzados (no hay
// tabla que relacione active_searches con propiedades de otro tenant) — no hay un contador
// guardado del que leer, y recalcularlo es lo que garantiza que quede "consistente con la base".
// Incluye 'expired' además de 'active' (antes solo traía 'active') para que el dashboard pueda
// ofrecer "Reactivar" sobre búsquedas vencidas — 'matched'/'cancelled' (archivadas) quedan afuera.
export async function listSearches(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;

  try {
    const { data: searches, error } = await tenantSupabase
      .from('active_searches')
      .select('id, raw_text, criteria, status, zone_status, zone_ids, zone_names, zone_text_original, created_at, expires_at')
      .eq('tenant_id', tenantId)
      .in('status', ['active', 'expired'])
      .order('created_at', { ascending: false });

    if (error) throw error;

    const results = await Promise.all((searches || []).map(async (search: any) => {
      let matchesCount = 0;
      try {
        // Reconstruye el zoneIntent persistido para que el recálculo en vivo respete el estado de
        // zona real de la búsqueda (antes de este cambio se ignoraba por completo acá).
        const zoneIntent: ZoneIntentRequest = {
          zone_status: search.zone_status,
          zona_ids: search.zone_ids || [],
          zona_nombres: search.zone_names || [],
          texto_ubicacion_original: search.zone_text_original || '',
          dormitorios_min: null,
          caracteristicas_claves: [],
          operacion: 'DESCONOCIDO'
        };
        const matches = await findCrossTenantMatches(tenantId, search.criteria, zoneIntent);
        matchesCount = matches.length;
      } catch (matchError: any) {
        logger.error({ error: matchError.message || matchError, tenantId, searchId: search.id }, '[BUSQUEDAS] Error al calcular el conteo de matches de una búsqueda activa');
      }

      return {
        id: search.id,
        raw_text: search.raw_text,
        criteria: search.criteria,
        status: search.status,
        zone_status: search.zone_status,
        zone_names: search.zone_names || [],
        created_at: search.created_at,
        expires_at: search.expires_at,
        days_remaining: calculateDaysRemaining(search.expires_at),
        matches_count: matchesCount
      };
    }));

    res.json({ searches: results });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[BUSQUEDAS] Error al listar búsquedas activas');
    res.status(500).json({ error: 'Error interno al listar las búsquedas.' });
  }
}

// KAN-40: baja de una búsqueda activa antes de que venza. Necesita distinguir 403 (existe pero es
// de otro tenant) de 404 (no existe para nadie) - el cliente tenant-scoped con RLS de KAN-63 nunca
// podría hacer esa distinción por sí solo (una fila ajena simplemente no aparece, sin importar si
// existe o no), así que el chequeo de existencia/dueño se hace con el cliente service-role antes
// de mutar con el cliente tenant-scoped (mismo patrón de "chequeo privilegiado + mutación
// tenant-scoped" que ya usan otros endpoints de este archivo).
// Cambio de semántica (dashboard visual): "eliminar" ya no es un hard delete — pasa a
// status='cancelled' (archivada). El registro se conserva para auditoría/historial y deja de
// aparecer en GET /api/searches (que solo trae 'active'/'expired').
export async function archiveSearch(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'El ID de la búsqueda está mal formado.' });
  }

  try {
    const { data: search, error: fetchError } = await supabase
      .from('active_searches')
      .select('id, tenant_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!search) {
      return res.status(404).json({ error: 'La búsqueda no existe.' });
    }
    if (search.tenant_id !== tenantId) {
      return res.status(403).json({ error: 'No tenés permiso para archivar esta búsqueda.' });
    }

    const { error: archiveError } = await tenantSupabase
      .from('active_searches')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (archiveError) throw archiveError;

    logger.info({ tenantId, searchId: id }, '[AUDITORIA] Búsqueda archivada por su propietario');

    sendWebPushToTenant(tenantId, {
      title: 'Búsqueda archivada',
      body: 'Diste de baja una búsqueda antes de que venciera.',
      tag: `search-deleted-${id}`,
      data: { url: '/' }
    }).catch((pushErr: any) => {
      logger.error({ error: pushErr.message || pushErr, tenantId, searchId: id }, '[BUSQUEDAS] Error al enviar la notificación de baja (no afecta el archivado ya confirmado)');
    });

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId, searchId: id }, '[BUSQUEDAS] Error al archivar la búsqueda');
    res.status(500).json({ error: 'Error interno al archivar la búsqueda.' });
  }
}

// Reactivación de una búsqueda vencida (dashboard visual): solo válida desde status='expired',
// vuelve a 'active' con 7 días nuevos de vencimiento a partir de ahora (mismo plazo que el trigger
// de creación, `set_active_searches_expires_at`, que no aplica en UPDATE). Mismo patrón de
// "chequeo privilegiado + mutación tenant-scoped" que DELETE de arriba.
export async function reactivateSearch(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'El ID de la búsqueda está mal formado.' });
  }

  try {
    const { data: search, error: fetchError } = await supabase
      .from('active_searches')
      .select('id, tenant_id, status')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!search) {
      return res.status(404).json({ error: 'La búsqueda no existe.' });
    }
    if (search.tenant_id !== tenantId) {
      return res.status(403).json({ error: 'No tenés permiso para reactivar esta búsqueda.' });
    }
    if (search.status !== 'expired') {
      return res.status(400).json({ error: 'Solo se pueden reactivar búsquedas vencidas.' });
    }

    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: updated, error: updateError } = await tenantSupabase
      .from('active_searches')
      .update({ status: 'active', expires_at: newExpiresAt })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id, expires_at')
      .single();

    if (updateError) throw updateError;

    logger.info({ tenantId, searchId: id }, '[AUDITORIA] Búsqueda reactivada por su propietario');

    res.json({ success: true, expires_at: updated.expires_at });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId, searchId: id }, '[BUSQUEDAS] Error al reactivar la búsqueda');
    res.status(500).json({ error: 'Error interno al reactivar la búsqueda.' });
  }
}
