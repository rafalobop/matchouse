import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as serviceRoleSupabase } from './supabase';
import { checkMatch } from '../utils/matcher';
import { ExtractedRealEstateRequest, ZoneIntentRequest } from './ai';
import { Property } from './excel';
import { logger } from './logger';
import { resolvePropertyZoneId } from './zonesService';

export interface CrossTenantMatch {
  tenant_id: string;
  property: Property;
  score: number;
  reasons: string[];
}

interface TenantScopedProperty {
  tenant_id: string;
  property: Property;
}

// Exportada para poder testear la reconstrucción de zone_display_name (ver
// tests/blindMatching.test.ts) — QA (KAN-37) encontró que esta función no lo seteaba, a
// diferencia de los otros dos lugares del repo que rehidratan un Property desde una fila de
// properties (src/index.ts#main() y src/services/whatsapp.ts), lo que hacía que
// ZoneMatchingStrategy rechazara sistemáticamente cualquier búsqueda con zona.
export function mapDbRowToProperty(row: any): Property {
  return {
    address: row.address,
    floor: row.floor || undefined,
    unit: row.unit || undefined,
    block: row.block || undefined,
    lot: row.lot || undefined,
    price: row.price,
    currency: row.currency,
    maintenance_fees: row.maintenance_fees,
    bedrooms: row.bedrooms,
    features: row.features || undefined,
    contact_info: row.contact_info || undefined,
    property_type: row.property_type,
    operation: row.operation,
    zone_display_name: row.sheet_name,
    sheet_name: row.sheet_name,
    latitude: row.latitude,
    longitude: row.longitude
  };
}

/**
 * Compara un pedido (búsqueda) contra un conjunto de propiedades ya resueltas por tenant,
 * reutilizando el motor de checkMatch existente (utils/matcher.ts). Función pura sin acceso a
 * red, para poder testear el ranking del matching bidireccional búsqueda↔cartera (KAN-37) sin
 * depender de Supabase.
 */
export function matchRequestAgainstProperties(
  request: ExtractedRealEstateRequest,
  candidates: TenantScopedProperty[],
  zoneIntent?: ZoneIntentRequest
): CrossTenantMatch[] {
  const matches: CrossTenantMatch[] = [];

  for (const { tenant_id, property } of candidates) {
    const result = checkMatch(request, property, zoneIntent);
    if (result.isMatch) {
      matches.push({ tenant_id, property, score: result.score, reasons: result.reasons });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

const MAX_CROSS_TENANT_MATCHES = 50;

/**
 * KAN-22: resuelve en paralelo el `neighborhood_id` (PostGIS + alias, ver
 * zonesService.resolvePropertyZoneId) de cada candidato y lo estampa en su `Property`, para que
 * `ZoneMatchingStrategy` (sync, sin red) pueda compararlo contra `zoneIntent.zona_id`. Solo se
 * invoca cuando la búsqueda trae una zona concreta — si `zoneIntent` es undefined o
 * 'DESCONOCIDO', ZoneMatchingStrategy ni siquiera mira `neighborhood_id` (cae al branch de
 * `request.zones` del Agente 1), así que resolverlo igual sería trabajo desperdiciado en el
 * camino más común (búsquedas sin zona específica).
 * Fail-soft por candidato: si la resolución de UNA propiedad falla (error de red/DB puntual), esa
 * propiedad queda con `neighborhood_id: null` (se comporta como "zona desconocida" en el
 * matcher, se descarta si el pedido pide una zona) en vez de tirar abajo toda la búsqueda.
 *
 * Usa siempre el cliente service-role (default de resolvePropertyZoneId), NUNCA el `client`
 * recibido por findCrossTenantMatches: `neighborhoods`/`neighborhood_aliases` tienen RLS
 * deny-all (KAN-85) — no hay policy que le dé lectura a un cliente tenant-scoped, aunque hoy
 * ningún llamador de findCrossTenantMatches pase uno.
 */
async function stampNeighborhoodIds(candidates: TenantScopedProperty[]): Promise<void> {
  await Promise.all(candidates.map(async ({ property }) => {
    try {
      property.neighborhood_id = await resolvePropertyZoneId(property);
    } catch (error: any) {
      logger.error({ error: error.message || error, address: property.address }, '[BLIND MATCHING] Error al resolver la zona de una propiedad candidata (se trata como zona desconocida)');
      property.neighborhood_id = null;
    }
  }));
}

/**
 * Motor de matching cross-tenant, dirección búsqueda→cartera (KAN-37): cruza el pedido de un
 * tenant contra la cartera de TODOS los demás tenants, excluyendo la propia. Usa
 * deliberadamente el cliente service-role en vez del `req.supabaseClient` scoped del patrón
 * "Tenant Context" (KAN-63): ese cliente aplica RLS `tenant_id = auth.uid()`, lo que bloquearía
 * por diseño la lectura cross-tenant que el matching ciego necesita. La exclusión de la cartera
 * propia se hace explícita en la query (`.neq('tenant_id', tenantId)`), no vía RLS.
 */
export async function findCrossTenantMatches(
  tenantId: string,
  request: ExtractedRealEstateRequest,
  zoneIntent?: ZoneIntentRequest,
  client: SupabaseClient = serviceRoleSupabase
): Promise<CrossTenantMatch[]> {
  let query = client
    .from('properties')
    .select('*')
    .neq('tenant_id', tenantId);

  if (request.operation !== 'desconocido') {
    query = query.eq('operation', request.operation);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ error: error.message, tenantId }, '[BLIND MATCHING] Error al leer cartera cross-tenant');
    throw error;
  }

  const candidates: TenantScopedProperty[] = (data || []).map((row: any) => ({
    tenant_id: row.tenant_id,
    property: mapDbRowToProperty(row)
  }));

  if (zoneIntent && zoneIntent.zona_id !== 'DESCONOCIDO') {
    await stampNeighborhoodIds(candidates);
  }

  return matchRequestAgainstProperties(request, candidates, zoneIntent).slice(0, MAX_CROSS_TENANT_MATCHES);
}
