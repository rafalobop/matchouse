import { SupabaseClient } from '@supabase/supabase-js';

// KAN-306 (continuación, 2026-09-04): extraído de adminPanelController.ts para reutilizarlo
// también en controllers/propertiesController.ts (DELETE de propiedades, restringido al dueño real de la
// agencia). Siempre recibe `actorId` (el auth.uid() real del que está logueado, no el
// `tenantId`/scope de agencia resuelto por tenantAuthMiddleware) — un colaborador nunca debe
// poder pasar este chequeo aunque su `tenantId` resuelva al id del dueño.
export async function requireOwner(
  actorId: string,
  client: SupabaseClient,
  forbiddenMessage: string = 'Solo los dueños de agencia pueden acceder al panel de administración.'
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data: profile, error } = await client
    .from('profiles')
    .select('role')
    .eq('id', actorId)
    .maybeSingle();

  if (error) throw error;
  if (!profile) {
    return { ok: false, status: 404, error: 'Perfil no encontrado.' };
  }
  if (profile.role !== 'owner') {
    return { ok: false, status: 403, error: forbiddenMessage };
  }
  return { ok: true };
}
