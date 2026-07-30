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
import { sendWebPushToTenant, buildMatchFoundPushPayload, buildIncomingMatchPushPayload, hasActivePushSubscriptions } from './webPush';
import { sendBlindMatchEmailFallback, sendIncomingMatchEmailFallback } from './notifier-email';
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
    .select('full_name, phone_number, agency_name')
    .eq('id', searchTenantId)
    .single();

  if (error || !data) {
    logger.error({ error: error?.message, searchTenantId }, '[PROPERTY MATCH WEBHOOK] No se pudo cargar el perfil del buscador para el snapshot.');
    return { full_name: null, phone_number: null, agency_name: null };
  }

  return {
    full_name: data.full_name ?? null,
    phone_number: data.phone_number ?? null,
    agency_name: data.agency_name ?? null
  };
}

/**
 * Procesa una propiedad recién subida contra las active_searches activas de otros tenants: por
 * cada match nuevo (no duplicado), persiste en blind_matches y notifica a ambos lados — al
 * buscador (nuevo match en su búsqueda activa, igual notificación que la primera de
 * POST /api/search) y al dueño de la propiedad nueva (aviso recíproco, igual que KAN-78).
 * Best-effort por match: un fallo puntual (insert o notificación de un match) no aborta el resto.
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

    const mappedMatchForNotify = {
      tenant_id: propertyOwnerTenantId,
      score: match.score,
      reasons: match.reasons,
      property: propertySnapshot
    };

    // Al buscador: mismo mecanismo que la primera notificación de POST /api/search.
    notifyMatchFound({
      hasActivePush: () => hasActivePushSubscriptions(match.tenant_id, client),
      sendPush: () => sendWebPushToTenant(match.tenant_id, buildMatchFoundPushPayload(match.search_id)),
      sendEmailFallback: () => sendBlindMatchEmailFallback(match.tenant_id, match.raw_text, [mappedMatchForNotify], client)
    }).catch((notifyErr: any) => {
      logger.error({ error: notifyErr.message || notifyErr, tenantId: match.tenant_id, searchId: match.search_id }, '[PROPERTY MATCH WEBHOOK] Error al notificar al buscador (no afecta el match ya persistido).');
    });

    // Al dueño de la propiedad nueva: mismo mecanismo recíproco que KAN-78.
    notifyMatchFound({
      hasActivePush: () => hasActivePushSubscriptions(propertyOwnerTenantId, client),
      sendPush: () => sendWebPushToTenant(propertyOwnerTenantId, buildIncomingMatchPushPayload(match.search_id)),
      sendEmailFallback: () => sendIncomingMatchEmailFallback(propertyOwnerTenantId, searcherSnapshot, match.raw_text, [mappedMatchForNotify], client)
    }).catch((notifyErr: any) => {
      logger.error({ error: notifyErr.message || notifyErr, tenantId: propertyOwnerTenantId, searchId: match.search_id }, '[PROPERTY MATCH WEBHOOK] Error al notificar al dueño de la propiedad nueva (no afecta el match ya persistido).');
    });
  }

  return { propertyId, matchesFound: matches.length, matchesInserted, matchesSkippedDuplicate };
}
