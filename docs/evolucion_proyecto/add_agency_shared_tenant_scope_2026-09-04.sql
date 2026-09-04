-- KAN-306 (continuación): comparte la cartera/búsquedas/matches/notificaciones del dueño de
-- agencia con sus colaboradores. Hasta acá, el panel de administración (KAN-306, primer pase)
-- solo gateaba el acceso al panel — la RLS de cada tabla tenant-scoped seguía siendo
-- `tenant_id = auth.uid()`, así que un colaborador logueado veía su propio dashboard vacío
-- (nunca tuvo cartera propia). Ver comentario explícito de "fuera de alcance" en
-- src/controllers/adminPanelController.ts (líneas 15-18 antes de este cambio).
--
-- Estrategia: `req.tenantId` (src/middleware/tenantAuth.ts) pasa a resolverse como el "scope
-- efectivo de agencia" (el id del dueño, sea quien sea el que está logueado) en vez del
-- `auth.uid()` crudo. Para que eso funcione contra RLS real (`req.supabaseClient`, patrón
-- Tenant Context KAN-63), cada política tenant-scoped deja de comparar contra `auth.uid()` y
-- pasa a comparar contra `current_agency_owner_id()`, que resuelve lo mismo server-side.
--
-- `profiles` (tabla de identidad propia, política `profiles_self_access`) NO cambia: sigue
-- `id = auth.uid()` — src/controllers/profileController.ts y adminPanelController.ts ahora
-- leen/escriben su propio perfil vía `req.actorId` (el auth.uid() real), nunca vía el scope
-- resuelto. No "corregir" esta política por simetría con las demás: es intencional.
--
-- Excepción explícita (pedido del usuario, 2026-09-04): un colaborador puede leer, cargar y
-- editar propiedades de la cartera de su agencia, pero NUNCA eliminarlas — solo el dueño real
-- puede borrar. Por eso `properties` no usa una única política `FOR ALL` como el resto: se
-- separa en SELECT/INSERT/UPDATE (scope de agencia) y un DELETE aparte que compara contra el
-- `auth.uid()` real (no contra el scope resuelto), así un colaborador jamás lo cumple.

CREATE OR REPLACE FUNCTION public.current_agency_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(agency_owner_id, id) FROM public.profiles WHERE id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.current_agency_owner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_agency_owner_id() TO authenticated;

-- properties
DROP POLICY "properties_tenant_isolation" ON public.properties;

CREATE POLICY "properties_agency_read" ON public.properties
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_agency_owner_id());

CREATE POLICY "properties_agency_insert" ON public.properties
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.current_agency_owner_id());

CREATE POLICY "properties_agency_update" ON public.properties
  FOR UPDATE TO authenticated
  USING (tenant_id = public.current_agency_owner_id())
  WITH CHECK (tenant_id = public.current_agency_owner_id());

CREATE POLICY "properties_owner_delete" ON public.properties
  FOR DELETE TO authenticated
  USING (tenant_id = auth.uid());

-- active_searches
DROP POLICY "active_searches_tenant_isolation" ON public.active_searches;
CREATE POLICY "active_searches_agency_isolation" ON public.active_searches
  FOR ALL TO authenticated
  USING (tenant_id = public.current_agency_owner_id())
  WITH CHECK (tenant_id = public.current_agency_owner_id());

-- web_push_subscriptions
DROP POLICY "web_push_subscriptions_tenant_isolation" ON public.web_push_subscriptions;
CREATE POLICY "web_push_subscriptions_agency_isolation" ON public.web_push_subscriptions
  FOR ALL TO authenticated
  USING (tenant_id = public.current_agency_owner_id())
  WITH CHECK (tenant_id = public.current_agency_owner_id());

-- tenant_excel_mappings
DROP POLICY "tenant_excel_mappings_tenant_isolation" ON public.tenant_excel_mappings;
CREATE POLICY "tenant_excel_mappings_agency_isolation" ON public.tenant_excel_mappings
  FOR ALL TO authenticated
  USING (tenant_id = public.current_agency_owner_id())
  WITH CHECK (tenant_id = public.current_agency_owner_id());

-- blind_matches: ambas políticas, para que un colaborador vea tanto los matches de las
-- búsquedas de su agencia (tenant_id) como los matches entrantes contra la cartera de su
-- agencia (matched_tenant_id).
DROP POLICY "blind_matches_tenant_isolation" ON public.blind_matches;
CREATE POLICY "blind_matches_agency_isolation" ON public.blind_matches
  FOR ALL TO authenticated
  USING (tenant_id = public.current_agency_owner_id())
  WITH CHECK (tenant_id = public.current_agency_owner_id());

DROP POLICY "blind_matches_matched_tenant_read" ON public.blind_matches;
CREATE POLICY "blind_matches_matched_agency_read" ON public.blind_matches
  FOR SELECT TO authenticated
  USING (matched_tenant_id = public.current_agency_owner_id());
