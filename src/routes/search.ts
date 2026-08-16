import express from 'express';
import { supabase } from '../services/supabase';
import { extractFromTextInput, extractZoneIntent, segmentSearchRequests, ZoneIntentRequest, AITimeoutError } from '../services/ai';
import { findCrossTenantMatches } from '../services/blindMatching';
import { validateFreeSearchText } from '../utils/searchValidation';
import { calculateDaysRemaining } from '../utils/activeSearches';
import { sendWebPushToTenant, buildMatchFoundPushPayload, buildIncomingMatchPushPayload, hasActivePushSubscriptions } from '../services/webPush';
import { sendBlindMatchEmailFallback, sendIncomingMatchEmailFallback } from '../services/notifier-email';
import { notifyMatchFound } from '../services/notifications';
import { broadcastMatchCountChanged } from '../services/realtimeHub';
import { createDistributedRateLimiter } from '../utils/rateLimit';
import { isValidUUID } from '../utils/idValidation';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { validateBodyWhitelist } from '../utils/bodyWhitelist';
import {
  buildBlindMatchInsertRows,
  mapPropertyToBlindMatchShape,
  groupMatchesByMatchedTenant,
  SearcherSnapshot
} from '../utils/blindMatchPersistence';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';

// KAN-142: matching ciego (búsqueda en texto libre y su ciclo de vida), extraído de src/index.ts.
// Es el dominio con más dependencias cruzadas del monolito original: motor de matching
// (blindMatching.ts), IA (ai.ts, Agentes 0/1/2), y ambos canales de notificación (webPush +
// notifier-email vía notifications.ts) — ver docs/evolucion_proyecto/refactor_index_routes.md
// para el mapa completo de estas dependencias ocultas.

// KAN-71/KAN-127: rate limit por tenantId — este endpoint dispara llamadas pagas a Gemini/OpenAI
// por request (extractFromTextInput, segmentSearchRequests), así que abuso acá tiene costo real,
// no solo carga de CPU.
const searchRateLimiter = createDistributedRateLimiter('search', config.searchRateLimitMax, config.searchRateLimitWindowMs);

interface SearchSegmentResult {
  success: boolean;
  raw_text: string;
  search?: { id: string; criteria: any; zone_status: string; zone_names: string[]; expires_at: string };
  matches?: any[];
  error?: string;
  code?: string;
}

// Procesa UN segmento de búsqueda ya extraído del mensaje original (ver segmentSearchRequests) a
// través del pipeline completo: Agente 1 -> Agente 2 (zona) -> insert en active_searches (ya con
// el estado de zona persistido) -> matching cross-tenant -> persistencia de blind_matches ->
// notificaciones bidireccionales. Extraído a función propia para poder correrlo una vez por cada
// sub-búsqueda de un mensaje multi-búsqueda.
export async function processSingleSearchSegment(
  tenantId: string,
  tenantSupabase: any,
  segmentText: string
): Promise<SearchSegmentResult> {
  const extractedData = await extractFromTextInput(segmentText);

  if (extractedData.operation === 'desconocido') {
    return { success: false, raw_text: segmentText, error: 'No pudimos clasificar el texto como un pedido de propiedad.' };
  }

  // KAN-22 + estados de zona (2026-08-11): zoneIntent (Agente 2) se resuelve ANTES del insert (no
  // después, como antes de este cambio) para poder persistir zone_status/zone_ids/zone_names/
  // zone_text_original en el mismo insert — elimina la ventana donde una fila de active_searches
  // existía sin haber corrido el Agente 2 todavía. extractZoneIntent nunca lanza (fallback
  // silencioso ante fallo total de IA), así que no necesita try/catch propio.
  const zoneIntent = await extractZoneIntent(segmentText, extractedData.operation);

  const { data: search, error: insertErr } = await tenantSupabase
    .from('active_searches')
    .insert({
      tenant_id: tenantId,
      raw_text: segmentText,
      criteria: extractedData,
      zone_status: zoneIntent.zone_status,
      zone_ids: zoneIntent.zona_ids,
      zone_names: zoneIntent.zona_nombres,
      zone_text_original: zoneIntent.texto_ubicacion_original
    })
    .select('id, criteria, zone_status, zone_names, created_at, expires_at')
    .single();

  if (insertErr) throw insertErr;

  const matches = await findCrossTenantMatches(tenantId, extractedData, zoneIntent);

  const mappedMatches = matches.map(m => ({
    tenant_id: m.tenant_id,
    score: m.score,
    reasons: m.reasons,
    property: mapPropertyToBlindMatchShape(m.property)
  }));

  // KAN-78: persistencia del resultado del matching ciego — se arma un snapshot del propio perfil
  // (buscador) para que el dueño de la propiedad matcheada pueda contactarlo más adelante sin
  // depender de que este mire a tiempo su notificación/email.
  let matchIds: (string | null)[] = mappedMatches.map(() => null);
  let searcherSnapshot: SearcherSnapshot = { full_name: null, phone_number: null, agency_name: null, email: null };
  if (mappedMatches.length > 0) {
    try {
      const { data: ownProfile, error: profileErr } = await tenantSupabase
        .from('profiles')
        .select('full_name, phone_number, agency_name, email')
        .eq('id', tenantId)
        .single();
      if (profileErr) throw profileErr;

      searcherSnapshot = {
        full_name: ownProfile?.full_name ?? null,
        phone_number: ownProfile?.phone_number ?? null,
        agency_name: ownProfile?.agency_name ?? null,
        email: ownProfile?.email ?? null
      };

      const insertRows = buildBlindMatchInsertRows(tenantId, search.id, segmentText, searcherSnapshot, mappedMatches);
      const { data: insertedMatches, error: matchInsertErr } = await tenantSupabase
        .from('blind_matches')
        .insert(insertRows)
        .select('id');

      if (matchInsertErr) throw matchInsertErr;
      matchIds = (insertedMatches || []).map((row: any) => row.id);
    } catch (persistErr: any) {
      // Best-effort: los matches ya se calcularon, no tiene sentido fallar una búsqueda exitosa
      // porque la persistencia falló — solo se pierde el historial/aviso al dueño de esta tanda.
      logger.error({ error: persistErr.message || persistErr, tenantId, searchId: search.id }, '[BUSQUEDA] Error al persistir los matches en blind_matches (no afecta la búsqueda ya calculada)');
    }
  }

  const mappedMatchesWithIds = mappedMatches.map((m, i) => ({ ...m, id: matchIds[i] ?? null }));

  // KAN-44: evento "match encontrado" en el único punto donde hoy se genera en vivo (una búsqueda
  // nueva). Fire-and-forget: no bloquea ni puede hacer fallar la respuesta ya devuelta al caller.
  // KAN-48: email como respaldo permanente — notifyMatchFound() solo lo dispara si el tenant no
  // tiene ninguna suscripción push activa, para no duplicar el aviso.
  if (mappedMatches.length > 0) {
    notifyMatchFound({
      hasActivePush: () => hasActivePushSubscriptions(tenantId),
      sendPush: () => sendWebPushToTenant(tenantId, buildMatchFoundPushPayload(search.id)),
      sendEmailFallback: () => sendBlindMatchEmailFallback(tenantId, segmentText, mappedMatches)
    }).catch((notifyErr: any) => {
      logger.error({ error: notifyErr.message || notifyErr, tenantId, searchId: search.id }, '[BUSQUEDA] Error al notificar el match encontrado (no afecta la búsqueda ya confirmada)');
    });

    // KAN-78: dirección recíproca — avisar también al dueño de cada propiedad matcheada.
    const bySearcherOwner = groupMatchesByMatchedTenant(mappedMatches);

    // KAN-88: evento en vivo del contador de matches.
    broadcastMatchCountChanged([tenantId, ...Object.keys(bySearcherOwner)]);

    for (const [ownerTenantId, ownerMatches] of Object.entries(bySearcherOwner)) {
      notifyMatchFound({
        hasActivePush: () => hasActivePushSubscriptions(ownerTenantId),
        sendPush: () => sendWebPushToTenant(ownerTenantId, buildIncomingMatchPushPayload(search.id)),
        sendEmailFallback: () => sendIncomingMatchEmailFallback(ownerTenantId, searcherSnapshot, segmentText, ownerMatches)
      }).catch((notifyErr: any) => {
        logger.error({ error: notifyErr.message || notifyErr, tenantId: ownerTenantId, searchId: search.id }, '[BUSQUEDA] Error al notificar al dueño de una propiedad matcheada (no afecta la búsqueda ya confirmada)');
      });
    }
  }

  return {
    success: true,
    raw_text: segmentText,
    search: { id: search.id, criteria: search.criteria, zone_status: search.zone_status, zone_names: search.zone_names, expires_at: search.expires_at },
    matches: mappedMatchesWithIds
  };
}

const router = express.Router();

// KAN-37: motor de matching bidireccional entre tenants, dirección búsqueda→cartera. Un tenant
// describe lo que busca en texto libre y recibe matches de la cartera de OTROS tenants (excluye
// la propia). Un mismo mensaje puede describir 2+ pedidos independientes — se segmenta primero
// (Agente 0, ver ai.ts#segmentSearchRequests) y cada segmento se procesa por separado, generando
// su propia fila de active_searches y su propio set de matches/notificaciones.
router.post('/api/search', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  const { text } = req.body;

  // KAN-134: whitelist de campos del body.
  const bodyWhitelistError = validateBodyWhitelist(req.body, ['text']);
  if (bodyWhitelistError) {
    return res.status(400).json({ error: bodyWhitelistError });
  }

  if (!(await searchRateLimiter.check(tenantId))) {
    logger.warn({ tenantId }, '[BUSQUEDA] Rate limit excedido en POST /api/search');
    return res.status(429).json({ error: 'Demasiadas búsquedas. Esperá un minuto e intentá de nuevo.' });
  }

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

  let segments: string[];
  try {
    segments = await segmentSearchRequests(text); // Agente 0 — fail-soft, nunca lanza
  } catch (error: any) {
    // Defensivo: aunque segmentSearchRequests no debería lanzar, un fallo acá no debe bloquear
    // el flujo — degradar al mensaje completo como única búsqueda.
    logger.error({ error: error.message || error, tenantId }, '[BUSQUEDA] Error inesperado en segmentación; se procesa como búsqueda única.');
    segments = [text];
  }

  // KAN-132: los segmentos de un mismo mensaje son independientes entre sí (cada uno arma su
  // propia fila de active_searches y su propio matching) — antes se procesaban uno por uno con
  // await secuencial, así que la latencia total escalaba linealmente con la cantidad de
  // pedidos detectados por el Agente 0. Promise.all los corre en paralelo (cada elemento del
  // map atrapa su propio error y siempre resuelve, nunca rechaza, para que un segmento fallido
  // no aborte el resto del lote — mismo comportamiento del try/catch por segmento que había en
  // el loop secuencial). El único rate limit del endpoint (searchRateLimiter, por tenant) ya se
  // chequea una única vez más arriba, antes de segmentar — procesar los segmentos en paralelo no
  // agrega chequeos adicionales ni puede superar ese límite.
  let anyAITimeout = false;

  const results: SearchSegmentResult[] = await Promise.all(
    segments.map(async (segmentText): Promise<SearchSegmentResult> => {
      try {
        return await processSingleSearchSegment(tenantId, tenantSupabase, segmentText);
      } catch (error: any) {
        if (error instanceof AITimeoutError) {
          anyAITimeout = true;
          return { success: false, raw_text: segmentText, error: error.message, code: 'AI_TIMEOUT' };
        }
        logger.error({ error: error.message || error, tenantId, segmentText }, '[BUSQUEDA] Error al procesar un segmento de búsqueda.');
        return { success: false, raw_text: segmentText, error: 'Error interno al procesar este segmento.' };
      }
    })
  );

  const allFailed = results.every(r => !r.success);
  const httpStatus = allFailed ? (anyAITimeout ? 504 : 500) : 200;

  res.status(httpStatus).json({
    success: !allFailed,
    segmented: segments.length > 1,
    searches: results
  });
});

// KAN-39: listado de búsquedas activas propias con conteo de matches cross-tenant. El conteo se
// recalcula en vivo reusando findCrossTenantMatches (mismo motor que POST /api/search) porque el
// matching ciego, por decisión explícita de KAN-37, no persiste los matches cruzados (no hay
// tabla que relacione active_searches con propiedades de otro tenant) — no hay un contador
// guardado del que leer, y recalcularlo es lo que garantiza que quede "consistente con la base".
// Incluye 'expired' además de 'active' (antes solo traía 'active') para que el dashboard pueda
// ofrecer "Reactivar" sobre búsquedas vencidas — 'matched'/'cancelled' (archivadas) quedan afuera.
router.get('/api/searches', tenantAuthMiddleware, async (req, res) => {
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
});

// KAN-40: baja de una búsqueda activa antes de que venza. Necesita distinguir 403 (existe pero es
// de otro tenant) de 404 (no existe para nadie) - el cliente tenant-scoped con RLS de KAN-63 nunca
// podría hacer esa distinción por sí solo (una fila ajena simplemente no aparece, sin importar si
// existe o no), así que el chequeo de existencia/dueño se hace con el cliente service-role antes
// de mutar con el cliente tenant-scoped (mismo patrón de "chequeo privilegiado + mutación
// tenant-scoped" que ya usan otros endpoints de este archivo).
// Cambio de semántica (dashboard visual): "eliminar" ya no es un hard delete — pasa a
// status='cancelled' (archivada). El registro se conserva para auditoría/historial y deja de
// aparecer en GET /api/searches (que solo trae 'active'/'expired').
router.delete('/api/searches/:id', tenantAuthMiddleware, async (req, res) => {
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
});

// Reactivación de una búsqueda vencida (dashboard visual): solo válida desde status='expired',
// vuelve a 'active' con 7 días nuevos de vencimiento a partir de ahora (mismo plazo que el trigger
// de creación, `set_active_searches_expires_at`, que no aplica en UPDATE). Mismo patrón de
// "chequeo privilegiado + mutación tenant-scoped" que DELETE de arriba.
router.post('/api/searches/:id/reactivate', tenantAuthMiddleware, async (req, res) => {
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
});

export default router;
