-- KAN-306 (pase de UI, 2026-09-04, punto 6 — pestañas Activos/Revocados + reactivar colaborador):
-- hasta acá `revokeCollaborator` (adminPanelController.ts) desvinculaba por completo al
-- colaborador (`role: 'owner', agency_owner_id: null`) — no había forma de "reactivarlo" sin
-- perder el vínculo con la agencia y reinventar la invitación desde cero. Esta migración agrega
-- una columna de estado independiente de `role`/`agency_owner_id` (que ya no se tocan al
-- revocar/reactivar) y actualiza `current_agency_owner_id()` para que un colaborador revocado
-- pierda de verdad el acceso a la cartera compartida (no solo visualmente en el panel).
--
-- El otro punto de enforcement real (la app usa service-role + filtros `.eq('tenant_id', ...)`
-- para el tráfico normal, no RLS — ver nota en add_agency_shared_tenant_scope_2026-09-04.sql) es
-- `resolveEffectiveTenantId()` en src/middleware/tenantAuth.ts, actualizado en el mismo commit
-- que esta migración.

ALTER TABLE public.profiles
  ADD COLUMN collaborator_status text
  CHECK (collaborator_status IS NULL OR collaborator_status IN ('active', 'revoked'));

UPDATE public.profiles SET collaborator_status = 'active' WHERE role = 'collaborator';

CREATE OR REPLACE FUNCTION public.current_agency_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN collaborator_status = 'revoked' THEN id
    ELSE COALESCE(agency_owner_id, id)
  END
  FROM public.profiles WHERE id = auth.uid();
$$;
