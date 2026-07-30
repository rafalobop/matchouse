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

  // KAN-79: property_type es tan indexable como operation (columna con CHECK constraint, cubierta
  // por idx_properties_meta_filters) — mismo criterio de escape que PropertyTypeMatchingStrategy
  // (utils/matcher.ts): 'otro' en el pedido significa "cualquier tipo", no se filtra en SQL. El
  // resto de las estrategias (zona, dormitorios, presupuesto, country, features) siguen
  // filtrándose en memoria vía checkMatch — no son columnas directamente comparables (zona
  // depende de un cómputo con PostGIS/alias, presupuesto de conversión de moneda, etc.).
  if (request.property_type !== 'otro') {
    query = query.eq('property_type', request.property_type);
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

export interface ActiveSearchCandidate {
  tenant_id: string;
  search_id: string;
  raw_text: string;
  criteria: ExtractedRealEstateRequest;
}

export interface PropertyMatch {
  tenant_id: string;
  search_id: string;
  raw_text: string;
  score: number;
  reasons: string[];
}

/**
 * KAN-79: dirección cartera→búsqueda — reversa de matchRequestAgainstProperties. Misma función
 * pura checkMatch (utils/matcher.ts), solo se invierte quién es "el pedido" y quién "la
 * propiedad". Sin zoneIntent (igual trade-off ya aceptado en GET /api/searches — active_searches
 * no persiste el resultado del Agente 2, solo el criteria plano del Agente 1).
 */
export function matchActiveSearchesAgainstProperty(
  property: Property,
  candidates: ActiveSearchCandidate[]
): PropertyMatch[] {
  const matches: PropertyMatch[] = [];

  for (const { tenant_id, search_id, raw_text, criteria } of candidates) {
    const result = checkMatch(criteria, property);
    if (result.isMatch) {
      matches.push({ tenant_id, search_id, raw_text, score: result.score, reasons: result.reasons });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

/**
 * KAN-79: motor de matching cross-tenant, dirección cartera→búsqueda — disparado por el trigger
 * de Postgres (`property_uploaded_trigger`, AFTER INSERT ON properties) vía pg_net, cuando entra
 * una propiedad nueva. Carga la propiedad y prefiltra en SQL las active_searches de OTROS tenants
 * cuyo criteria->>operation/property_type coincida (o sea el comodín 'desconocido'/'otro' del
 * Agente 1) — misma filosofía de "SQL para lo indexable, resto en memoria" que
 * findCrossTenantMatches. La interpolación directa de property.operation/property_type en el
 * string de .or() es segura: ambas columnas tienen CHECK constraint en la base (no pueden traer
 * comas/comillas/otros valores), nunca son input de usuario en este punto.
 */
export async function findMatchingActiveSearchesForProperty(
  propertyId: string,
  client: SupabaseClient = serviceRoleSupabase
): Promise<{ property: Property; tenantId: string; matches: PropertyMatch[] } | null> {
  const { data: propertyRow, error: propertyError } = await client
    .from('properties')
    .select('*')
    .eq('id', propertyId)
    .single();

  if (propertyError || !propertyRow) {
    logger.error({ error: propertyError?.message, propertyId }, '[BLIND MATCHING] No se pudo cargar la propiedad para el matching cartera→búsqueda');
    return null;
  }

  const property = mapDbRowToProperty(propertyRow);
  const tenantId: string = propertyRow.tenant_id;

  let query = client
    .from('active_searches')
    .select('id, tenant_id, raw_text, criteria')
    .eq('status', 'active')
    .neq('tenant_id', tenantId);

  query = query.or(`criteria->>operation.eq.desconocido,criteria->>operation.eq.${property.operation}`);
  query = query.or(`criteria->>property_type.eq.otro,criteria->>property_type.eq.${property.property_type}`);

  const { data, error } = await query;
  if (error) {
    logger.error({ error: error.message, propertyId, tenantId }, '[BLIND MATCHING] Error al leer active_searches cross-tenant para la propiedad nueva');
    throw error;
  }

  const candidates: ActiveSearchCandidate[] = (data || []).map((row: any) => ({
    tenant_id: row.tenant_id,
    search_id: row.id,
    raw_text: row.raw_text,
    criteria: row.criteria as ExtractedRealEstateRequest
  }));

  const matches = matchActiveSearchesAgainstProperty(property, candidates);
  return { property, tenantId, matches };
}
