// KAN-79: orquestador de la dirección cartera→búsqueda del matching bidireccional. Disparado por
// POST /internal/property-match-check (src/index.ts), a su vez llamado por el trigger de Postgres
// `property_uploaded_trigger` (AFTER INSERT ON properties) vía pg_net cuando entra una propiedad
// nueva. Sin sesión de usuario (contexto de background, como coordinator.ts/notifier*.ts) — usa
// siempre el cliente service-role, inyectable para tests.

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as serviceRoleSupabase } from './supabase';
import { findMatchingActiveSearchesForProperty } from './blindMatching';
import {
  buildIncomingPropertyMatchInsertRow,
  mapPropertyToBlindMatchShape,
  SearcherSnapshot
} from '../utils/blindMatchPersistence';
import { notifyMatchFound } from './notifications';
import { sendWebPushToTenant, buildIncomingMatchPushPayload, hasActivePushSubscriptions } from './webPush';
import { sendIncomingMatchEmailFallback } from './notifier-email';
import { broadcastMatchCountChanged } from './realtimeHub';
import { logger } from './logger';

export interface ProcessPropertyUploadedResult {
  propertyId: string;
  matchesFound: number;
  matchesInserted: number;
  matchesSkippedDuplicate: number;
}

async function blindMatchAlreadyExists(searchId: string, propertyId: string, client: SupabaseClient): Promise<boolean> {
  const { count, error } = await client
    .from('blind_matches')
    .select('id', { count: 'exact', head: true })
    .eq('search_id', searchId)
    .eq('property_id', propertyId);

  if (error) {
    // Fail-open: mejor arriesgar una fila/notificación duplicada puntual que perder el aviso
    // entero por un error transitorio de este chequeo (mismo criterio que hasActivePushSubscriptions).
    logger.error({ error: error.message, searchId, propertyId }, '[PROPERTY MATCH WEBHOOK] Error chequeando duplicados en blind_matches, se procede a insertar igual.');
    return false;
  }

  return (count || 0) > 0;
}

async function fetchSearcherSnapshot(searchTenantId: string, client: SupabaseClient): Promise<SearcherSnapshot> {
  const { data, error } = await client
    .from('profiles')
    .select('full_name, phone_number, agency_name, email')
    .eq('id', searchTenantId)
    .single();

  if (error || !data) {
    logger.error({ error: error?.message, searchTenantId }, '[PROPERTY MATCH WEBHOOK] No se pudo cargar el perfil del buscador para el snapshot.');
    return { full_name: null, phone_number: null, agency_name: null, email: null };
  }

  return {
    full_name: data.full_name ?? null,
    phone_number: data.phone_number ?? null,
    agency_name: data.agency_name ?? null,
    email: data.email ?? null
  };
}

/**
 * Procesa una propiedad recién subida contra las active_searches activas de otros tenants: por
 * cada match nuevo (no duplicado), persiste en blind_matches y notifica solo al dueño de la
 * propiedad nueva (aviso recíproco, igual que KAN-78) — el buscador no recibe push/email de este
 * evento (decisión de producto, ver comentario más abajo), solo el nudge de WS que ya reciben
 * ambos lados. Best-effort por match: un fallo puntual (insert o notificación de un match) no
 * aborta el resto.
 */
export async function processPropertyUploaded(
  propertyId: string,
  client: SupabaseClient = serviceRoleSupabase
): Promise<ProcessPropertyUploadedResult> {
  const result = await findMatchingActiveSearchesForProperty(propertyId, client);

  if (!result || result.matches.length === 0) {
    return { propertyId, matchesFound: 0, matchesInserted: 0, matchesSkippedDuplicate: 0 };
  }

  const { property, tenantId: propertyOwnerTenantId, matches } = result;
  const propertySnapshot = mapPropertyToBlindMatchShape(property);

  let matchesInserted = 0;
  let matchesSkippedDuplicate = 0;
  // KAN-88: tenants a avisar por WS de que su conteo de matches pudo cambiar. Se junta en un Set
  // y se emite una sola vez al final (no por match) — una propiedad puede matchear varias
  // búsquedas del mismo tenant, y no tiene sentido mandarle el mismo evento repetido.
  const tenantsToNotifyRealtime = new Set<string>();

  for (const match of matches) {
    const isDuplicate = await blindMatchAlreadyExists(match.search_id, propertyId, client);
    if (isDuplicate) {
      matchesSkippedDuplicate++;
      continue;
    }

    const searcherSnapshot = await fetchSearcherSnapshot(match.tenant_id, client);
    const row = buildIncomingPropertyMatchInsertRow(
      match.tenant_id,
      match.search_id,
      match.raw_text,
      searcherSnapshot,
      propertyOwnerTenantId,
      propertyId,
      propertySnapshot,
      match.score,
      match.reasons
    );

    const { error: insertErr } = await client.from('blind_matches').insert(row);

    if (insertErr) {
      logger.error({ error: insertErr.message, propertyId, searchId: match.search_id }, '[PROPERTY MATCH WEBHOOK] Error al persistir un match cartera→búsqueda (se continúa con el resto).');
      continue;
    }

    matchesInserted++;
    tenantsToNotifyRealtime.add(match.tenant_id);
    tenantsToNotifyRealtime.add(propertyOwnerTenantId);

    const mappedMatchForNotify = {
      tenant_id: propertyOwnerTenantId,
      score: match.score,
      reasons: match.reasons,
      property: propertySnapshot
    };

    // Decisión de producto (2026-08-21) — el buscador (match.tenant_id) ya NO se notifica acá
    // tampoco (mismo criterio que POST /api/search, ver src/routes/search.ts): solo el dueño de
    // la propiedad nueva se entera, porque es quien tiene que contactar al buscador. El WS de
    // abajo le sigue avisando al buscador que su conteo cambió (nudge inocuo), pero sin push/email
    // con contenido.

    // Al dueño de la propiedad nueva: mismo mecanismo recíproco que KAN-78.
    notifyMatchFound({
      hasActivePush: () => hasActivePushSubscriptions(propertyOwnerTenantId, client),
      sendPush: () => sendWebPushToTenant(propertyOwnerTenantId, buildIncomingMatchPushPayload(match.search_id)),
      sendEmailFallback: () => sendIncomingMatchEmailFallback(propertyOwnerTenantId, searcherSnapshot, match.raw_text, [mappedMatchForNotify], client)
    }).catch((notifyErr: any) => {
      logger.error({ error: notifyErr.message || notifyErr, tenantId: propertyOwnerTenantId, searchId: match.search_id }, '[PROPERTY MATCH WEBHOOK] Error al notificar al dueño de la propiedad nueva (no afecta el match ya persistido).');
    });
  }

  if (tenantsToNotifyRealtime.size > 0) {
    broadcastMatchCountChanged(tenantsToNotifyRealtime);
  }

  return { propertyId, matchesFound: matches.length, matchesInserted, matchesSkippedDuplicate };
}
