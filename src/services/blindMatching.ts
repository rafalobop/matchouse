import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as serviceRoleSupabase } from './supabase';
import { checkMatch } from '../utils/matcher';
import { ExtractedRealEstateRequest, ZoneIntentRequest, ZoneStatus } from './ai';
import { Property } from './excel';
import { logger } from './logger';
import { resolvePropertyZoneId, resolveMultipleNeighborhoodsByText } from './zonesService';
import { withRetry } from '../utils/withRetry';

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
 * `ZoneMatchingStrategy` (sync, sin red) pueda compararlo contra `zoneIntent.zona_ids`. Solo se
 * invoca cuando la búsqueda trae zona resuelta (zone_status === 'DEFINIDA') — si es INDEFINIDA
 * (no se filtra) o DESCONOCIDA (se rechaza igual, filtro duro), resolverlo sería trabajo
 * desperdiciado.
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

  if (zoneIntent && zoneIntent.zone_status === 'DEFINIDA') {
    await stampNeighborhoodIds(candidates);
  }

  return matchRequestAgainstProperties(request, candidates, zoneIntent).slice(0, MAX_CROSS_TENANT_MATCHES);
}

export interface ActiveSearchCandidate {
  tenant_id: string;
  search_id: string;
  raw_text: string;
  criteria: ExtractedRealEstateRequest;
  zoneIntent: ZoneIntentRequest;
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
 * propiedad". A diferencia de la versión previa, ahora SÍ recibe zoneIntent (reconstruido desde
 * las columnas persistidas de active_searches, ver findMatchingActiveSearchesForProperty) —
 * cierra el gap donde esta dirección ignoraba por completo la zona resuelta del Agente 2.
 */
export function matchActiveSearchesAgainstProperty(
  property: Property,
  candidates: ActiveSearchCandidate[]
): PropertyMatch[] {
  const matches: PropertyMatch[] = [];

  for (const { tenant_id, search_id, raw_text, criteria, zoneIntent } of candidates) {
    const result = checkMatch(criteria, property, zoneIntent);
    if (result.isMatch) {
      matches.push({ tenant_id, search_id, raw_text, score: result.score, reasons: result.reasons });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

// Reconstruye un ZoneIntentRequest "mínimo" a partir de las columnas persistidas de
// active_searches (zone_status/zone_ids/zone_names/zone_text_original). dormitorios_min y
// caracteristicas_claves del Agente 2 nunca se persistieron (ni antes ni con este cambio) — ya
// están cubiertos por `criteria` (Agente 1), así que quedan en null/[] acá; solo se reconstruye lo
// necesario para que ZoneMatchingStrategy funcione.
function reconstructZoneIntentFromRow(row: {
  zone_status: string;
  zone_ids: string[] | null;
  zone_names: string[] | null;
  zone_text_original: string | null;
}): ZoneIntentRequest {
  return {
    zone_status: row.zone_status as ZoneStatus,
    zona_ids: row.zone_ids || [],
    zona_nombres: row.zone_names || [],
    texto_ubicacion_original: row.zone_text_original || '',
    dormitorios_min: null,
    caracteristicas_claves: [],
    operacion: 'DESCONOCIDO'
  };
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
 *
 * Self-healing: para las candidatas en zone_status='DESCONOCIDA' con texto de ubicación
 * persistido, reintenta la resolución contra el índice ACTUAL de neighborhoods/aliases (puede
 * haber cambiado desde el intento original) antes de evaluar el match. Si ahora resuelve, se
 * persiste la curación (UPDATE best-effort) y se evalúa con la zona ya definida.
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
    .select('id, tenant_id, raw_text, criteria, zone_status, zone_ids, zone_names, zone_text_original')
    .eq('status', 'active')
    .neq('tenant_id', tenantId);

  query = query.or(`criteria->>operation.eq.desconocido,criteria->>operation.eq.${property.operation}`);
  query = query.or(`criteria->>property_type.eq.otro,criteria->>property_type.eq.${property.property_type}`);

  const { data, error } = await query;
  if (error) {
    logger.error({ error: error.message, propertyId, tenantId }, '[BLIND MATCHING] Error al leer active_searches cross-tenant para la propiedad nueva');
    throw error;
  }

  const rows = data || [];

  // --- Self-healing: reintentar resolución de zona para las candidatas DESCONOCIDA de este lote ---
  const healedById = new Map<string, { zone_status: ZoneStatus; zona_ids: string[]; zona_nombres: string[] }>();
  const unknownRows = rows.filter((r: any) => r.zone_status === 'DESCONOCIDA' && r.zone_text_original);

  await Promise.all(unknownRows.map(async (row: any) => {
    const mentions = String(row.zone_text_original).split(' | ').map((s: string) => s.trim()).filter(Boolean);
    try {
      const resolved = await withRetry(() => resolveMultipleNeighborhoodsByText(mentions, client), { attempts: 3 });
      if (resolved.length > 0) {
        healedById.set(row.id, {
          zone_status: 'DEFINIDA',
          zona_ids: resolved.map(r => r.id),
          zona_nombres: resolved.map(r => r.name)
        });
      }
      // Si sigue sin resolver, se queda DESCONOCIDA — no se reescribe la fila (evita un UPDATE
      // vacío cada vez que entra una propiedad nueva mientras la zona sigue sin existir).
    } catch (err: any) {
      logger.error({ error: err.message || err, searchId: row.id }, '[BLIND MATCHING] Self-healing de zona DESCONOCIDA falló tras reintentos; se mantiene DESCONOCIDA.');
    }
  }));

  // Persistir las curadas ANTES de evaluar el match — best-effort por fila: un fallo de UPDATE no
  // aborta el resto del lote ni el matching de esta propiedad.
  await Promise.all(Array.from(healedById.entries()).map(async ([searchId, healed]) => {
    const { error: updateErr } = await client
      .from('active_searches')
      .update({
        zone_status: healed.zone_status,
        zone_ids: healed.zona_ids,
        zone_names: healed.zona_nombres
      })
      .eq('id', searchId);
    if (updateErr) {
      logger.error({ error: updateErr.message, searchId }, '[BLIND MATCHING] No se pudo persistir la curación de zona (self-healing); se evalúa igual con el valor recién resuelto en memoria.');
    }
  }));

  // Estampar neighborhood_id de la propiedad SOLO si hace falta (alguna candidata quedó DEFINIDA
  // tras el healing, o ya lo estaba de entrada).
  const anyDefinida = rows.some((r: any) => healedById.get(r.id)?.zone_status === 'DEFINIDA' || r.zone_status === 'DEFINIDA');
  if (anyDefinida) {
    property.neighborhood_id = await resolvePropertyZoneId(property, client).catch((err: any) => {
      logger.error({ error: err.message || err, propertyId }, '[BLIND MATCHING] Error al resolver zona de la propiedad para self-healing (se trata como zona desconocida).');
      return null;
    });
  }

  const candidates: ActiveSearchCandidate[] = rows.map((row: any) => {
    const healed = healedById.get(row.id);
    const effective = healed ?? { zone_status: row.zone_status, zona_ids: row.zone_ids || [], zona_nombres: row.zone_names || [] };
    return {
      tenant_id: row.tenant_id,
      search_id: row.id,
      raw_text: row.raw_text,
      criteria: row.criteria as ExtractedRealEstateRequest,
      zoneIntent: reconstructZoneIntentFromRow({
        zone_status: effective.zone_status,
        zone_ids: effective.zona_ids,
        zone_names: effective.zona_nombres,
        zone_text_original: row.zone_text_original
      })
    };
  });

  const matches = matchActiveSearchesAgainstProperty(property, candidates);
  return { property, tenantId, matches };
}
