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

export interface ZonePointInput {
  /** Índice arbitrario definido por el llamador (ej. la posición en el array original) — permite
   * remapear cada resultado a su punto de origen aunque haya coordenadas repetidas. */
  idx: number;
  latitude: number;
  longitude: number;
}

export interface ZonePointMatch extends Neighborhood {
  matchType: 'contains' | 'nearby';
}

/**
 * KAN-130: versión batch de `findNeighborhoodByPoint` — resuelve la zona de N puntos con un solo
 * round-trip a Postgres (RPC `neighborhoods_for_points`), en vez de N llamadas individuales.
 * Pensado para eliminar el patrón N+1 de `GET /api/properties` en el panel admin. Devuelve un
 * `Map` keyeado por `idx` — los puntos sin ninguna zona resuelta (ni exacta ni cercana) simplemente
 * no tienen entrada en el Map, igual que `findNeighborhoodByPoint` devuelve `null`.
 */
export async function findNeighborhoodsForPoints(
  points: ZonePointInput[],
  client: SupabaseClient = supabase,
  maxDistanceMeters?: number
): Promise<Map<number, ZonePointMatch>> {
  if (points.length === 0) return new Map();

  for (const p of points) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) {
      throw new ZonesServiceError(`Coordenadas inválidas en el punto idx=${p.idx}: lat=${p.latitude}, lon=${p.longitude}`);
    }
  }

  const params: Record<string, unknown> = {
    points: points.map((p) => ({ idx: p.idx, lat: p.latitude, lon: p.longitude }))
  };
  if (maxDistanceMeters !== undefined) {
    params.max_distance_meters = maxDistanceMeters;
  }

  const { data, error } = await client.rpc('neighborhoods_for_points', params);

  if (error) {
    throw new ZonesServiceError(`No se pudieron resolver zonas en batch para ${points.length} puntos: ${error.message}`, error);
  }

  const result = new Map<number, ZonePointMatch>();
  for (const row of (data ?? []) as any[]) {
    if (row.id == null) continue; // el punto no cayó dentro ni cerca de ninguna zona conocida
    result.set(row.idx, { id: row.id, name: row.name, group_id: row.group_id, matchType: row.match_type });
  }
  return result;
}

// --- KAN-22: resolución por texto libre (fallback para propiedades/búsquedas sin coordenadas) ---

interface ZoneKeyword {
  keyword: string;
  neighborhoodId: string;
  neighborhoodName: string;
}

// Referencia compartida entre tenants, baja tasa de cambio (151 zonas / 21 alias a la fecha) —
// mismo criterio de cacheo en memoria que sessionCache en src/index.ts, TTL más largo porque acá
// no hay riesgo de servir una sesión vencida, solo datos de catálogo.
const ZONE_KEYWORD_CACHE_TTL_MS = 5 * 60 * 1000;
let zoneKeywordCache: { entries: ZoneKeyword[]; expiresAt: number } | null = null;

// KAN-130 (fix post-QA): "single-flight" — mientras el cache está frío, `resolvePropertiesZoneInfoBatch`
// puede llamar a esta función decenas de veces en paralelo (una por propiedad de la página, vía
// `Promise.all`). El chequeo del cache de arriba es síncrono pero el refresco es async, así que sin
// esto todas esas llamadas concurrentes ven el cache vacío al mismo tiempo y cada una dispara su
// propio fetch (2 queries) — con 50 propiedades eso son 100 queries en vez de 2, justo lo que QA
// detectó midiendo llamadas reales contra Supabase (102 en cache frío vs. 1 en cache caliente).
// Guardar la promise en curso (no solo el resultado ya resuelto) hace que las llamadas concurrentes
// esperen el mismo fetch en vez de disparar el suyo. Se limpia en el `finally` (éxito o error) para
// que un fetch fallido no deje el índice bloqueado esperando una promise rechazada para siempre.
let zoneKeywordFetchInFlight: Promise<ZoneKeyword[]> | null = null;

async function getZoneKeywordIndex(client: SupabaseClient): Promise<ZoneKeyword[]> {
  if (zoneKeywordCache && zoneKeywordCache.expiresAt > Date.now()) {
    return zoneKeywordCache.entries;
  }
  if (zoneKeywordFetchInFlight) {
    return zoneKeywordFetchInFlight;
  }

  zoneKeywordFetchInFlight = (async () => {
    const [{ data: neighborhoods, error: neighborhoodsError }, { data: aliases, error: aliasesError }] = await Promise.all([
      client.from('neighborhoods').select('id, name'),
      client.from('neighborhood_aliases').select('alias, neighborhood_id, neighborhoods(name)')
    ]);

    if (neighborhoodsError) {
      throw new ZonesServiceError(`No se pudo cargar el índice de zonas (neighborhoods): ${neighborhoodsError.message}`, neighborhoodsError);
    }
    if (aliasesError) {
      throw new ZonesServiceError(`No se pudo cargar el índice de zonas (neighborhood_aliases): ${aliasesError.message}`, aliasesError);
    }

    const entries: ZoneKeyword[] = [
      ...(neighborhoods ?? []).map((n: any) => ({ keyword: String(n.name).toLowerCase(), neighborhoodId: n.id, neighborhoodName: n.name })),
      ...(aliases ?? [])
        .filter((a: any) => a.neighborhoods)
        .map((a: any) => ({ keyword: String(a.alias).toLowerCase(), neighborhoodId: a.neighborhood_id, neighborhoodName: a.neighborhoods.name }))
    ]
      .filter((entry) => entry.keyword.trim().length > 0)
      // Coincidencias más largas/específicas primero (ej. "barrio norte" antes que "norte") para
      // evitar que un alias corto y genérico le gane a uno más preciso contenido en el mismo texto.
      .sort((a, b) => b.keyword.length - a.keyword.length);

    zoneKeywordCache = { entries, expiresAt: Date.now() + ZONE_KEYWORD_CACHE_TTL_MS };
    return entries;
  })();

  try {
    return await zoneKeywordFetchInFlight;
  } finally {
    zoneKeywordFetchInFlight = null;
  }
}

export interface NeighborhoodTextMatch {
  id: string;
  name: string;
}

/**
 * Resuelve la zona (`neighborhoods.id` + `name`) a partir de texto libre, buscando el nombre de
 * zona o alias más específico (más largo) contenido en el texto. Reemplaza al heurístico
 * hardcodeado que antes vivía en `utils/matcher.ts` (`classifyPropertyZoneId`) — ahora la
 * normalización sale de `neighborhoods`/`neighborhood_aliases` (151/21 filas a la fecha) en vez de
 * una lista estática de ~15 zonas. Devuelve `null` (no es un error) si ningún keyword conocido
 * aparece en el texto. KAN-92: expone también el `name` legible (no solo el `id`/UUID) para que
 * los llamadores puedan mostrarlo al usuario en vez del id interno.
 */
export async function resolveNeighborhoodByText(text: string, client: SupabaseClient = supabase): Promise<NeighborhoodTextMatch | null> {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return null;

  const keywords = await getZoneKeywordIndex(client);
  const match = keywords.find((entry) => normalized.includes(entry.keyword));
  return match ? { id: match.neighborhoodId, name: match.neighborhoodName } : null;
}

/**
 * Resuelve MÚLTIPLES menciones de ubicación (ej. ["villa lujan", "tafi viejo"]) contra el mismo
 * índice cacheado que `resolveNeighborhoodByText`, en vez de quedarse solo con la primera.
 * Deduplica por `neighborhoodId` (si dos menciones distintas resuelven a la misma zona, aparece
 * una sola vez en el resultado). Menciones que no resuelven ningún keyword simplemente se omiten
 * del resultado — no es un error por mención individual, el llamador decide si "ninguna resolvió"
 * implica un estado bloqueante (ver ai.ts#resolveZoneIntent).
 */
export async function resolveMultipleNeighborhoodsByText(
  mentions: string[],
  client: SupabaseClient = supabase
): Promise<NeighborhoodTextMatch[]> {
  const keywords = await getZoneKeywordIndex(client);
  const results = new Map<string, NeighborhoodTextMatch>();

  for (const mention of mentions) {
    const normalized = mention.toLowerCase();
    if (!normalized.trim()) continue;
    const match = keywords.find((entry) => normalized.includes(entry.keyword));
    if (match && !results.has(match.neighborhoodId)) {
      results.set(match.neighborhoodId, { id: match.neighborhoodId, name: match.neighborhoodName });
    }
  }

  return Array.from(results.values());
}

/**
 * Igual que `resolveNeighborhoodByText`, pero solo el id — usada donde no hace falta el nombre
 * (ej. `resolvePropertyZoneId`, que estampa `property.neighborhood_id` para comparación interna).
 */
export async function resolveNeighborhoodIdByText(text: string, client: SupabaseClient = supabase): Promise<string | null> {
  const match = await resolveNeighborhoodByText(text, client);
  return match ? match.id : null;
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

export interface PropertyZoneInfo {
  /** Zona resuelta a mostrar (por punto si hay match; si no, por texto; si no, null). */
  zone: NeighborhoodTextMatch | null;
  /** De dónde salió `zone`: PostGIS exacto/cercano, fallback de texto, o ninguna de las dos. */
  source: 'point' | 'text' | 'none';
  /**
   * Zona que sugiere el texto (dirección/features/hoja), aunque el punto haya resuelto otra.
   * Sirve para detectar "el excel dice una zona pero las coordenadas dicen otra" en el panel admin.
   */
  textSuggestedZone: NeighborhoodTextMatch | null;
  /** true si `source === 'point'` pero el texto sugiere una zona distinta. */
  hasDiscrepancy: boolean;
}

/**
 * Igual que `resolvePropertyZoneId`, pero devuelve el detalle completo (zona + de dónde salió +
 * si hay discrepancia punto/texto) en vez de solo el id. Pensado para el panel admin, donde el
 * operador necesita ver esa señal para decidir si corregir las coordenadas de una propiedad.
 * Consolida la lógica que antes vivía duplicada en scripts/check-zone-resolution.ts.
 */
export async function resolvePropertyZoneInfo(
  property: PropertyLocationFields,
  client: SupabaseClient = supabase
): Promise<PropertyZoneInfo> {
  const text = `${property.address} ${property.features ?? ''} ${property.sheet_name} ${property.zone_display_name ?? ''}`;
  const textSuggestedZone = await resolveNeighborhoodByText(text, client);

  const hasCoords =
    property.latitude !== undefined && property.latitude !== null &&
    property.longitude !== undefined && property.longitude !== null &&
    property.latitude !== 0 && property.longitude !== 0;

  if (hasCoords) {
    const byPoint = await findNeighborhoodByPoint(property.latitude!, property.longitude!, client);
    if (byPoint) {
      const zone = { id: byPoint.id, name: byPoint.name };
      const hasDiscrepancy = !!textSuggestedZone && textSuggestedZone.id !== byPoint.id;
      return { zone, source: 'point', textSuggestedZone, hasDiscrepancy };
    }
  }

  if (textSuggestedZone) {
    return { zone: textSuggestedZone, source: 'text', textSuggestedZone, hasDiscrepancy: false };
  }

  return { zone: null, source: 'none', textSuggestedZone: null, hasDiscrepancy: false };
}

export interface PropertyForZoneBatch extends PropertyLocationFields {
  /**
   * Zona ya cacheada en `properties.zone_id` (típicamente resuelta por el llamador vía un select
   * con join embebido a `neighborhoods`). Si viene presente, esta propiedad no participa del RPC
   * batch — se usa tal cual, igual que si `resolvePropertyZoneInfo` ya hubiera resuelto por punto
   * en una llamada anterior. `undefined`/`null` significa "sin caché, hay que resolverla".
   */
  cachedZone?: NeighborhoodTextMatch | null;
}

/**
 * KAN-130: versión batch de `resolvePropertyZoneInfo` — resuelve N propiedades con, como mucho,
 * 1 round-trip a Postgres (el RPC `neighborhoods_for_points`, solo para las que no tienen
 * `cachedZone` y sí coordenadas válidas). La resolución por texto es 100% en memoria gracias al
 * cache de `getZoneKeywordIndex`, así que no suma round-trips por propiedad. Pensada para
 * reemplazar el `Promise.all(rows.map(resolvePropertyZoneInfo))` de `GET /api/properties`
 * (panel admin), que antes disparaba hasta 2 llamadas a Postgres por propiedad de la página.
 * Devuelve un array en el mismo orden que `properties`.
 */
export async function resolvePropertiesZoneInfoBatch(
  properties: PropertyForZoneBatch[],
  client: SupabaseClient = supabase
): Promise<PropertyZoneInfo[]> {
  const textSuggestedZones = await Promise.all(
    properties.map((p) => {
      const text = `${p.address} ${p.features ?? ''} ${p.sheet_name} ${p.zone_display_name ?? ''}`;
      return resolveNeighborhoodByText(text, client);
    })
  );

  const pointsToResolve: ZonePointInput[] = [];
  properties.forEach((p, idx) => {
    if (p.cachedZone) return; // ya resuelta, no participa del batch

    const hasCoords =
      p.latitude !== undefined && p.latitude !== null &&
      p.longitude !== undefined && p.longitude !== null &&
      p.latitude !== 0 && p.longitude !== 0;
    if (hasCoords) {
      pointsToResolve.push({ idx, latitude: p.latitude!, longitude: p.longitude! });
    }
  });

  const resolvedPoints = pointsToResolve.length > 0
    ? await findNeighborhoodsForPoints(pointsToResolve, client)
    : new Map<number, ZonePointMatch>();

  return properties.map((p, idx) => {
    const textSuggestedZone = textSuggestedZones[idx];

    if (p.cachedZone) {
      const hasDiscrepancy = !!textSuggestedZone && textSuggestedZone.id !== p.cachedZone.id;
      return { zone: p.cachedZone, source: 'point' as const, textSuggestedZone, hasDiscrepancy };
    }

    const byPoint = resolvedPoints.get(idx);
    if (byPoint) {
      const zone = { id: byPoint.id, name: byPoint.name };
      const hasDiscrepancy = !!textSuggestedZone && textSuggestedZone.id !== byPoint.id;
      return { zone, source: 'point' as const, textSuggestedZone, hasDiscrepancy };
    }

    if (textSuggestedZone) {
      return { zone: textSuggestedZone, source: 'text' as const, textSuggestedZone, hasDiscrepancy: false };
    }

    return { zone: null, source: 'none' as const, textSuggestedZone: null, hasDiscrepancy: false };
  });
}

/** Solo para tests: fuerza a que la próxima resolución por texto vuelva a consultar la base. */
export function __clearZoneKeywordCacheForTests(): void {
  zoneKeywordCache = null;
  zoneKeywordFetchInFlight = null;
}
