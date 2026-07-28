import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as serviceRoleSupabase } from './supabase';
import { checkMatch } from '../utils/matcher';
import { ExtractedRealEstateRequest, ZoneIntentRequest } from './ai';
import { Property } from './excel';
import { logger } from './logger';

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

  return matchRequestAgainstProperties(request, candidates, zoneIntent).slice(0, MAX_CROSS_TENANT_MATCHES);
}
