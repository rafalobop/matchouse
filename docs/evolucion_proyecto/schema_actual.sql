-- Estado REAL de la tabla public.match_queue, confirmado por introspección directa
-- (mcp__supabase__execute_sql sobre information_schema.columns + list_tables verbose)
-- contra el proyecto Supabase "matchouse" (bbadahhljpddlckyrmvi) el 2026-07-02.
--
-- Este archivo documenta el schema drift detectado en refactor_brief_2.md, tarea 1:
-- las columnas score, validation_score, is_valid fueron agregadas manualmente en el
-- dashboard de Supabase en algún momento posterior a la migración
-- "20260616202656_evolucion_multi_tenant_base" (la única migración registrada por
-- Supabase para este proyecto) y nunca quedaron versionadas en el repo hasta ahora.
--
-- migration_rls_and_sessions.sql (en este mismo directorio) queda intacto como
-- artefacto histórico de la ronda de auth vieja (usa nombres "Tenant"/"Property"/
-- "Message"/"Match" pre-SPEC-0012) — no refleja el estado actual, no confundir.
--
-- NOTA sobre .agent/CONTEXT.md: ese doc listaba columnas "notification_status"
-- ('PENDING'|'SENT') y "fecha" que NO existen en la base real. Es drift de
-- documentación (nadie las lee ni escribe en el código), no de schema — se corrige
-- en CONTEXT.md como parte de esta misma sesión.

CREATE TABLE public.match_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  property_id uuid NOT NULL,
  whatsapp_group_name text NOT NULL,
  whatsapp_sender_name text NOT NULL,
  whatsapp_sender_phone text NOT NULL,
  raw_message_text text NOT NULL,
  is_notified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),

  -- Columnas agregadas manualmente en el dashboard (schema drift, ahora documentado):
  score double precision,
  validation_score double precision,
  is_valid boolean,
  reasoning text,
  match_details text,
  user_review_status text DEFAULT 'PENDING'::text,
  feedback_reason text,

  -- Agregadas en esta misma sesión (spec_0014) vía mcp__supabase__apply_migration,
  -- migración "add_email_notification_tracking_columns", para trackear apertura y
  -- click de los deep links wa.me en el email de notificación consolidada:
  email_opened_at timestamptz,
  email_clicked_at timestamptz,

  CONSTRAINT match_queue_pkey PRIMARY KEY (id),
  CONSTRAINT match_queue_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.profiles(id),
  CONSTRAINT match_queue_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id)
);

-- Referencia rápida de tablas relacionadas (mismo snapshot de introspección):
--
-- public.profiles (RLS habilitado, ver ADENDA de seguridad más abajo):
--   id uuid PK (FK -> auth.users.id), full_name text, email text UNIQUE,
--   created_at timestamptz DEFAULT timezone('utc', now())
--
-- public.properties (RLS habilitado, ver ADENDA de seguridad más abajo):
--   id uuid PK DEFAULT gen_random_uuid(), tenant_id uuid (FK -> profiles.id),
--   address text, floor text, unit text, block text, lot text,
--   operation text CHECK (operation IN ('compra','alquiler','venta')),
--   property_type text CHECK (property_type IN ('departamento','casa','terreno','local','oficina','otro')),
--   price double precision, currency text CHECK (currency IN ('USD','ARS')),
--   maintenance_fees double precision DEFAULT 0, bedrooms integer DEFAULT 0,
--   features text, contact_info text, sheet_name text,
--   latitude double precision NOT NULL, longitude double precision NOT NULL (sin default —
--   confirmado por introspección real en KAN-63; el código siempre manda 0/0 como fallback,
--   ver excel.ts syncPropertiesToDatabase),
--   location geometry (PostGIS, nullable, no usada aún por resolvePropertyZoneId()),
--   created_at timestamptz DEFAULT timezone('utc', now())
--
-- ADENDA DE SEGURIDAD (2026-07-02, sesión posterior a spec_0014):
-- RLS ya está HABILITADO vía mcp__supabase__apply_migration, migración
-- "enable_rls_tenant_isolation":
--   - profiles: FOR ALL TO authenticated USING/WITH CHECK (id = auth.uid())
--   - properties, match_queue, whatsapp_sessions: FOR ALL TO authenticated
--     USING/WITH CHECK (tenant_id = auth.uid())
--   - neighborhood_groups/neighborhoods/neighborhood_aliases: RLS habilitado,
--     sin políticas (deny-all) — no hay código en src/ que las use hoy.
--   - spatial_ref_sys: deliberadamente NO se tocó (catálogo del sistema PostGIS,
--     no datos de la app; algunas funciones de PostGIS lo consultan internamente).
--
-- IMPORTANTE — hallazgo real detectado al auditar esto: `tenantAuthMiddleware`
-- (src/index.ts) usa el cliente SERVICE-ROLE para todo (nunca `getTenantClient()`,
-- el único que respeta RLS). O sea: RLS es hoy defensa en profundidad genuina
-- (protege si la anon key se filtra), pero NO aisla tenants dentro del flujo real
-- de la app — eso seguiría dependiendo de los filtros `.eq('tenant_id', ...)`
-- explícitos en cada query. Cambiar el middleware para usar `getTenantClient()`
-- es un cambio de arquitectura mayor, pendiente para otra sesión.
--
-- Bug real e independiente de RLS, corregido en esta misma sesión: `GET /api/matches`
-- y `POST /api/matches/:id/feedback` no filtraban por tenant_id — cualquier tenant
-- autenticado podía ver/editar matches de otros tenants. Ya tienen `.eq('tenant_id', tenantId)`.
--
-- `web_push_subscriptions` (KAN-19, creada 2026-07-14 vía mcp__supabase__apply_migration,
-- migración "create_web_push_subscriptions_table"): la tabla no existía y notifier.ts/
-- index.ts la consultaban igual, fallando silenciosamente. Columnas creadas para calzar
-- con el código real (no con la descripción original del ticket, que mencionaba
-- `user_id`/`subscription_details` — nombres que no coinciden con ningún query existente):
--
-- CREATE TABLE public.web_push_subscriptions (
--   id uuid NOT NULL DEFAULT gen_random_uuid(),
--   tenant_id uuid NOT NULL,
--   subscription jsonb NOT NULL,
--   created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
--   CONSTRAINT web_push_subscriptions_pkey PRIMARY KEY (id),
--   CONSTRAINT web_push_subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.profiles(id)
-- );
-- CREATE INDEX web_push_subscriptions_tenant_id_idx ON public.web_push_subscriptions (tenant_id);
--
-- RLS habilitado con la misma política que properties/match_queue/whatsapp_sessions:
-- FOR ALL TO authenticated USING/WITH CHECK (tenant_id = auth.uid()).
--
-- `active_searches` (KAN-35, creada 2026-07-28 vía mcp__supabase__apply_migration,
-- migraciones "create_active_searches_table" y "harden_active_searches_trigger_search_path"):
-- almacena las búsquedas activas de un tenant (matching ciego) para cruzarlas contra
-- mensajes de propiedades entrantes.
--
-- CREATE TABLE public.active_searches (
--   id uuid NOT NULL DEFAULT gen_random_uuid(),
--   tenant_id uuid NOT NULL,
--   criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
--   raw_text text NOT NULL,
--   status text NOT NULL DEFAULT 'active',
--   created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
--   expires_at timestamptz NOT NULL,
--   CONSTRAINT active_searches_pkey PRIMARY KEY (id),
--   CONSTRAINT active_searches_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.profiles(id),
--   CONSTRAINT active_searches_status_check CHECK (status IN ('active','expired','matched','cancelled'))
-- );
--
-- Índices: active_searches_tenant_id_idx (tenant_id), active_searches_status_idx (status).
--
-- `expires_at` no se puede resolver con un DEFAULT de columna (Postgres no permite
-- referenciar otra columna del mismo row ahí), así que se usa un trigger BEFORE INSERT
-- (`set_active_searches_expires_at`, con search_path fijo por hardening) que solo
-- completa `created_at + interval '7 days'` cuando el caller no mandó `expires_at`
-- explícito — verificado con inserts reales (auto y con override).
--
-- Los valores de `status` ('active'|'expired'|'matched'|'cancelled') y el tipo jsonb
-- de `criteria` son decisiones de diseño propias (el ticket KAN-35 solo pedía el campo
-- `status` sin especificar sus valores ni el tipo de `criteria`); no hay código
-- consumidor todavía que los use, quedan abiertos a ajustarse cuando se implemente
-- el matching ciego real.
--
-- RLS habilitado con la misma política tenant_id = auth.uid() que el resto de tablas
-- tenant-scoped.
--
-- Pruebas de rendimiento (transacción con ROLLBACK, sin dejar datos de prueba):
-- 30k filas sintéticas repartidas en 50 tenants y distribución de status realista
-- (70% active / 10% expired / 10% matched / 10% cancelled). `EXPLAIN ANALYZE`
-- confirmó Bitmap Index Scan sobre active_searches_tenant_id_idx (tenant_id, ~2%
-- selectividad) e Index Scan sobre active_searches_status_idx (status='cancelled',
-- ~10% selectividad) — ambos índices se usan y evitan el seq scan sobre 30k filas.
