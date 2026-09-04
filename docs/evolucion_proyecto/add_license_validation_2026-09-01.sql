-- KAN-306 (continuación): validación de matrícula profesional en el registro (AC1/AC2) y
-- registro temporal cuando la fuente externa está desactualizada (AC5).
--
-- licensed_agents: caché local del padrón público de matriculados del Colegio de Corredores
-- Inmobiliarios de Tucumán (https://ccit.com.ar/padron/). Esa URL no expone API — es una tabla
-- HTML estática (~420 filas, sin paginación, generada por el plugin "Ninja Tables" de WordPress),
-- confirmado por inspección real de la página. Se sincroniza periódicamente por scraping
-- (src/services/licenseRegistry.ts) en vez de consultarse por request. No es tenant-scoped: es un
-- catálogo de referencia compartido, de solo uso server-side.
CREATE TABLE public.licensed_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_number text NOT NULL UNIQUE,
  agency_name text,
  broker_name text,
  cuit text,
  address text,
  phones text,
  email text,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX licensed_agents_synced_at_idx ON public.licensed_agents(synced_at);

-- RLS habilitado sin ninguna policy (deny-all), mismo patrón que neighborhood_* (ver
-- schema_actual.sql): ni anon ni authenticated pueden leer/escribir esta tabla vía PostgREST. El
-- único acceso es server-side con el cliente service-role.
ALTER TABLE public.licensed_agents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles
  ADD COLUMN license_number text,
  ADD COLUMN license_validation_status text NOT NULL DEFAULT 'pending'
    CHECK (license_validation_status IN ('validated', 'pending', 'rejected'));

-- Hardening (mismo criterio que `role`/`agency_owner_id`/`plan`): la política RLS de profiles es
-- row-level (id = auth.uid()), no column-level — sin este REVOKE, un tenant autenticado podría
-- auto-asignarse license_validation_status='validated' vía req.supabaseClient sin pasar la
-- validación real contra licensed_agents. license_number NO se revoca (es el dato que el propio
-- usuario ingresa), pero toda la escritura de profiles en el flujo de registro
-- (src/controllers/profileController.ts#updateProfile) pasa igual por el cliente service-role,
-- porque necesita escribir license_validation_status en la misma operación.
REVOKE UPDATE (license_validation_status) ON public.profiles FROM authenticated;
