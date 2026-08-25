-- Fase 1 pre-lanzamiento (brokaza-frontend/Next_Steps.md): columna `plan` en `profiles` para
-- poder enforcear límites de uso por tenant (100 propiedades / 10 búsquedas por mes en el plan
-- Free). Un solo valor activo hoy ('FREE') pero con la CHECK ya pensada para sumar tiers pagos
-- más adelante sin migrar de tipo.
--
-- text + CHECK, no un enum nativo de Postgres: mismo patrón que ya usa el resto del schema para
-- valores fijos (properties.operation, properties.property_type, properties.currency,
-- active_searches.status). Ampliar la lista de valores permitidos más adelante es una migración
-- que reescribe el CHECK, sin la fricción de ALTER TYPE ... ADD VALUE de un enum nativo.

ALTER TABLE public.profiles
  ADD COLUMN plan text NOT NULL DEFAULT 'FREE'
  CHECK (plan IN ('FREE'));

-- Hardening: la política RLS de profiles es FOR ALL ... USING/WITH CHECK (id = auth.uid()), o sea
-- que solo protege QUÉ FILA puede tocar un tenant, no QUÉ COLUMNA. req.supabaseClient (patrón
-- "Tenant Context" de KAN-63, ver src/middleware/tenantAuth.ts) respeta RLS de verdad en el tráfico
-- real de la app -- sin este REVOKE, un futuro endpoint de "editar mi perfil" que use ese cliente
-- y no excluya `plan` del whitelist de campos le permitiría a cualquier tenant auto-asignarse un
-- plan pago. service_role (el único que debe poder cambiar `plan`, vía un futuro flujo de billing/
-- admin) no se ve afectado por el REVOKE, igual que no se ve afectado por RLS.
REVOKE UPDATE (plan) ON public.profiles FROM authenticated;
