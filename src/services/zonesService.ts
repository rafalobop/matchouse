import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface NeighborhoodGroup {
  id: string;
  name: string;
  description: string | null;
}

export interface Neighborhood {
  id: string;
  name: string;
  group_id: string | null;
}

export class ZonesServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ZonesServiceError';
  }
}

/**
 * Lista los grupos de zonas (`neighborhood_groups`). Tabla de referencia compartida entre
 * tenants (RLS deny-all, KAN-85) — se lee siempre con el cliente service-role.
 */
export async function listNeighborhoodGroups(client: SupabaseClient = supabase): Promise<NeighborhoodGroup[]> {
  const { data, error } = await client
    .from('neighborhood_groups')
    .select('id, name, description')
    .order('name');

  if (error) {
    throw new ZonesServiceError(`No se pudieron listar los grupos de zonas: ${error.message}`, error);
  }
  return data ?? [];
}

/**
 * Lista las zonas (`neighborhoods`), opcionalmente filtradas por grupo. No trae `boundary`
 * (WKB crudo, sin utilidad fuera de queries espaciales server-side).
 */
export async function listNeighborhoods(groupId?: string, client: SupabaseClient = supabase): Promise<Neighborhood[]> {
  let query = client.from('neighborhoods').select('id, name, group_id');
  if (groupId) {
    query = query.eq('group_id', groupId);
  }
  const { data, error } = await query.order('name');

  if (error) {
    throw new ZonesServiceError(`No se pudieron listar las zonas: ${error.message}`, error);
  }
  return data ?? [];
}

/**
 * Resuelve un alias/keyword de texto libre (ej. "yerba buena") a su zona (`neighborhoods`)
 * vía `neighborhood_aliases`, sin distinguir mayúsculas/minúsculas ni espacios extremos.
 * Devuelve `null` si no hay ningún alias registrado — no es un error, es la ausencia de match.
 */
export async function findNeighborhoodByAlias(alias: string, client: SupabaseClient = supabase): Promise<Neighborhood | null> {
  const normalized = alias.trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await client
    .from('neighborhood_aliases')
    .select('neighborhood_id, neighborhoods(id, name, group_id)')
    .ilike('alias', normalized)
    .maybeSingle();

  if (error) {
    throw new ZonesServiceError(`No se pudo resolver el alias de zona "${alias}": ${error.message}`, error);
  }
  if (!data || !data.neighborhoods) return null;

  return data.neighborhoods as unknown as Neighborhood;
}

/**
 * Resuelve qué zona contiene un punto geográfico (lat/lon), vía la función PostGIS
 * `neighborhood_for_point` (KAN-22): primero intenta `ST_Within` exacto (punto dentro del
 * polígono); si ninguno lo contiene, cae a `ST_DWithin` (geography, metros) para tolerar
 * imprecisión de geocodificación cerca de un límite. `maxDistanceMeters` es opcional — si no
 * se pasa, se omite del payload del RPC y se usa el DEFAULT de la función en la base (150m).
 * Devuelve `null` si el punto no cae dentro ni cerca de ninguna zona conocida.
 */
export async function findNeighborhoodByPoint(
  latitude: number,
  longitude: number,
  client: SupabaseClient = supabase,
  maxDistanceMeters?: number
): Promise<Neighborhood | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new ZonesServiceError(`Coordenadas inválidas: lat=${latitude}, lon=${longitude}`);
  }

  const params: Record<string, number> = { lat: latitude, lon: longitude };
  if (maxDistanceMeters !== undefined) {
    params.max_distance_meters = maxDistanceMeters;
  }

  const { data, error } = await client.rpc('neighborhood_for_point', params);

  if (error) {
    throw new ZonesServiceError(`No se pudo resolver la zona para (${latitude}, ${longitude}): ${error.message}`, error);
  }
  if (!data || data.length === 0) return null;

  return data[0] as Neighborhood;
}

// --- KAN-22: resolución por texto libre (fallback para propiedades/búsquedas sin coordenadas) ---

interface ZoneKeyword {
  keyword: string;
  neighborhoodId: string;
}

// Referencia compartida entre tenants, baja tasa de cambio (151 zonas / 21 alias a la fecha) —
// mismo criterio de cacheo en memoria que sessionCache en src/index.ts, TTL más largo porque acá
// no hay riesgo de servir una sesión vencida, solo datos de catálogo.
const ZONE_KEYWORD_CACHE_TTL_MS = 5 * 60 * 1000;
let zoneKeywordCache: { entries: ZoneKeyword[]; expiresAt: number } | null = null;

async function getZoneKeywordIndex(client: SupabaseClient): Promise<ZoneKeyword[]> {
  if (zoneKeywordCache && zoneKeywordCache.expiresAt > Date.now()) {
    return zoneKeywordCache.entries;
  }

  const [{ data: neighborhoods, error: neighborhoodsError }, { data: aliases, error: aliasesError }] = await Promise.all([
    client.from('neighborhoods').select('id, name'),
    client.from('neighborhood_aliases').select('alias, neighborhood_id')
  ]);

  if (neighborhoodsError) {
    throw new ZonesServiceError(`No se pudo cargar el índice de zonas (neighborhoods): ${neighborhoodsError.message}`, neighborhoodsError);
  }
  if (aliasesError) {
    throw new ZonesServiceError(`No se pudo cargar el índice de zonas (neighborhood_aliases): ${aliasesError.message}`, aliasesError);
  }

  const entries: ZoneKeyword[] = [
    ...(neighborhoods ?? []).map((n: any) => ({ keyword: String(n.name).toLowerCase(), neighborhoodId: n.id })),
    ...(aliases ?? []).map((a: any) => ({ keyword: String(a.alias).toLowerCase(), neighborhoodId: a.neighborhood_id }))
  ]
    .filter((entry) => entry.keyword.trim().length > 0)
    // Coincidencias más largas/específicas primero (ej. "barrio norte" antes que "norte") para
    // evitar que un alias corto y genérico le gane a uno más preciso contenido en el mismo texto.
    .sort((a, b) => b.keyword.length - a.keyword.length);

  zoneKeywordCache = { entries, expiresAt: Date.now() + ZONE_KEYWORD_CACHE_TTL_MS };
  return entries;
}

/**
 * Resuelve el id de zona (`neighborhoods.id`) a partir de texto libre, buscando el nombre de zona
 * o alias más específico (más largo) contenido en el texto. Reemplaza al heurístico hardcodeado
 * que antes vivía en `utils/matcher.ts` (`classifyPropertyZoneId`) — ahora la normalización sale
 * de `neighborhoods`/`neighborhood_aliases` (151/21 filas a la fecha) en vez de una lista estática
 * de ~15 zonas. Devuelve `null` (no es un error) si ningún keyword conocido aparece en el texto.
 */
export async function resolveNeighborhoodIdByText(text: string, client: SupabaseClient = supabase): Promise<string | null> {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return null;

  const keywords = await getZoneKeywordIndex(client);
  const match = keywords.find((entry) => normalized.includes(entry.keyword));
  return match ? match.neighborhoodId : null;
}

interface PropertyLocationFields {
  latitude?: number | null;
  longitude?: number | null;
  address: string;
  features?: string;
  sheet_name: string;
  zone_display_name?: string;
}

/**
 * Resuelve el id de zona (`neighborhoods.id`) de una propiedad (KAN-22): primero por punto
 * (`findNeighborhoodByPoint`, si tiene lat/lng válidas y distintas de 0/0), y si no hay coincidencia
 * (o no tiene coordenadas — `undefined`/`null`, este último el caso de un geocoding fallido,
 * KAN-80), cae a resolución por texto (`resolveNeighborhoodIdByText`) sobre dirección +
 * características + hoja + zona de origen. Devuelve `null` si ninguna de las dos vías resuelve
 * una zona — el llamador debe tratar eso como "zona desconocida", no como error.
 */
export async function resolvePropertyZoneId(property: PropertyLocationFields, client: SupabaseClient = supabase): Promise<string | null> {
  if (
    property.latitude !== undefined && property.latitude !== null &&
    property.longitude !== undefined && property.longitude !== null &&
    property.latitude !== 0 && property.longitude !== 0
  ) {
    const byPoint = await findNeighborhoodByPoint(property.latitude, property.longitude, client);
    if (byPoint) return byPoint.id;
  }

  const text = `${property.address} ${property.features ?? ''} ${property.sheet_name} ${property.zone_display_name ?? ''}`;
  return resolveNeighborhoodIdByText(text, client);
}

/** Solo para tests: fuerza a que la próxima resolución por texto vuelva a consultar la base. */
export function __clearZoneKeywordCacheForTests(): void {
  zoneKeywordCache = null;
}
