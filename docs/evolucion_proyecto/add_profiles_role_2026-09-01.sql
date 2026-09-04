-- KAN-306: base de roles dueño/colaborador para el panel de administración de agencia. Alcance
-- acordado con el usuario: solo el gate de acceso al panel (quién puede otorgar/revocar acceso de
-- colaboradores), no el reparto de la cartera/búsquedas/matches del dueño con sus colaboradores
-- (seguiría necesitando RLS por agency_owner_id, cambio de mayor alcance, fuera de este ticket).
--
-- role: 'owner' (default, retrocompatible con todos los tenants existentes) | 'collaborator'.
-- agency_owner_id: NULL para dueños; para un colaborador, apunta al profile del dueño que le
-- otorgó acceso. Mismo patrón text+CHECK que el resto del schema para valores fijos (ver
-- add_profiles_plan_2026-08-24.sql).

ALTER TABLE public.profiles
  ADD COLUMN role text NOT NULL DEFAULT 'owner'
  CHECK (role IN ('owner', 'collaborator'));

ALTER TABLE public.profiles
  ADD COLUMN agency_owner_id uuid NULL REFERENCES public.profiles(id);

CREATE INDEX profiles_agency_owner_id_idx ON public.profiles(agency_owner_id) WHERE agency_owner_id IS NOT NULL;

-- Hardening (mismo criterio que `REVOKE UPDATE (plan)`): la política RLS de profiles es
-- FOR ALL ... USING/WITH CHECK (id = auth.uid()), row-level, no column-level. Sin este REVOKE,
-- cualquier tenant autenticado podría auto-asignarse role='owner' o pisar agency_owner_id vía
-- req.supabaseClient (patrón Tenant Context, KAN-63) en cualquier endpoint futuro que no excluya
-- estas columnas del whitelist. Solo service_role (el que usan los endpoints del panel de
-- administración de KAN-306, src/controllers/adminPanelController.ts) puede escribir estas columnas.
REVOKE UPDATE (role, agency_owner_id) ON public.profiles FROM authenticated;
