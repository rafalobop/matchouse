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
 * `neighborhood_for_point` (ST_Contains, ver migración KAN-85). Devuelve `null` si el punto
 * no cae dentro de ninguna zona conocida.
 */
export async function findNeighborhoodByPoint(latitude: number, longitude: number, client: SupabaseClient = supabase): Promise<Neighborhood | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new ZonesServiceError(`Coordenadas inválidas: lat=${latitude}, lon=${longitude}`);
  }

  const { data, error } = await client.rpc('neighborhood_for_point', {
    lat: latitude,
    lon: longitude
  });

  if (error) {
    throw new ZonesServiceError(`No se pudo resolver la zona para (${latitude}, ${longitude}): ${error.message}`, error);
  }
  if (!data || data.length === 0) return null;

  return data[0] as Neighborhood;
}
