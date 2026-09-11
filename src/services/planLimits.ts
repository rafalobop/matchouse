import { PLAN_LIMITS, PlanLimits, PlanTier } from '../config/planLimits';

// Fase 1 pre-lanzamiento: helpers de lectura para enforcear los límites de uso del plan del tenant
// (ver src/config/planLimits.ts). Todas las queries usan el cliente pasado por el caller
// (req.supabaseClient, patrón "Tenant Context" de KAN-63) más el filtro explícito tenant_id, mismo
// criterio que ya usan properties.ts/upload.ts para el resto de los conteos por tenant.

// KAN-341: `data.plan` viene de la columna `profiles.plan` (CHECK a nivel BD, ver
// docs/evolucion_proyecto/add_profiles_plan_2026-08-24.sql) — hoy el único valor posible es
// 'FREE', pero un drift entre ese CHECK y PLAN_LIMITS (ej. un tier nuevo agregado a uno y no al
// otro) haría que esto devolviera `undefined` en silencio, y los tres callers (properties.ts,
// uploadController.ts, searchController.ts) revientan con un TypeError críptico al desestructurar
// (`Cannot destructure property 'maxProperties' of 'undefined'`) en vez de un error claro.
export async function getTenantPlanLimits(tenantId: string, supabaseClient: any): Promise<PlanLimits> {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('plan')
    .eq('id', tenantId)
    .single();

  if (error) throw error;

  const limits = PLAN_LIMITS[data.plan as PlanTier];
  if (!limits) {
    throw new Error(`Plan no reconocido: "${data.plan}" (tenant ${tenantId}). No hay límites definidos en PLAN_LIMITS para este plan.`);
  }

  return limits;
}

export async function countTenantProperties(tenantId: string, supabaseClient: any): Promise<number> {
  const { count, error } = await supabaseClient
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (error) throw error;

  return count || 0;
}

// Cuota de creación mensual, no de "búsquedas activas simultáneas": cuenta todas las filas creadas
// en el mes calendario UTC en curso sin importar su status. Reactivar una búsqueda vencida
// (reactivateSearch, ver controllers/searchController.ts) reusa la fila existente con un nuevo
// expires_at en vez de insertar una fila nueva, así que no vuelve a consumir cuota.
export async function countTenantSearchesThisMonth(tenantId: string, supabaseClient: any): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const { count, error } = await supabaseClient
    .from('active_searches')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', startOfMonth);

  if (error) throw error;

  return count || 0;
}
