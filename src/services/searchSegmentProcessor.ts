import { extractFromTextInput, extractZoneIntent } from './ai';
import { findCrossTenantMatches } from './blindMatching';
import { sendWebPushToTenant, buildIncomingMatchPushPayload, hasActivePushSubscriptions } from './webPush';
import { sendIncomingMatchEmailFallback } from './notifier-email';
import { notifyMatchFound } from './notifications';
import { broadcastMatchCountChanged } from './realtimeHub';
import { logger } from './logger';
import {
  buildBlindMatchInsertRows,
  mapPropertyToBlindMatchShape,
  groupMatchesByMatchedTenant,
  SearcherSnapshot
} from '../utils/blindMatchPersistence';

export interface SearchSegmentResult {
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

  // Decisión de producto (2026-08-21) — el buscador (tenantId) ya NO se notifica de los matches de
  // su propia búsqueda (ni push ni email). Solo el dueño de la propiedad matcheada se entera (ver
  // bloque de abajo), porque es quien tiene que contactar al buscador — el buscador nunca debe
  // tener forma de enterarse por su cuenta. blind_matches se sigue persistiendo igual (arriba,
  // auditoría + GET /admin/api/metrics), y el WS de abajo sigue avisándole al propio buscador que
  // su conteo de matches cambió (nudge de refetch inocuo — la UI del tenant no expone ningún dato
  // de esos matches, ver `brokaza-frontend`), solo se removió el aviso directo (push/email) con
  // contenido.
  if (mappedMatches.length > 0) {
    // KAN-78: dirección recíproca — avisar también al dueño de cada propiedad matcheada.
    // KAN-303: se agrupa mappedMatchesWithIds (no mappedMatches) para que cada grupo lleve el id
    // real de su fila en blind_matches y el push pueda resaltar esas filas puntuales al entrar.
    const bySearcherOwner = groupMatchesByMatchedTenant(mappedMatchesWithIds);

    // KAN-88: evento en vivo del contador de matches.
    broadcastMatchCountChanged([tenantId, ...Object.keys(bySearcherOwner)]);

    for (const [ownerTenantId, ownerMatches] of Object.entries(bySearcherOwner)) {
      const ownerMatchIds = ownerMatches.map((m) => m.id).filter((id): id is string => Boolean(id));
      notifyMatchFound({
        hasActivePush: () => hasActivePushSubscriptions(ownerTenantId),
        sendPush: () => sendWebPushToTenant(ownerTenantId, buildIncomingMatchPushPayload(ownerMatchIds)),
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
