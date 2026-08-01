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

-- ELIMINADA (KAN-78, 2026-07-29): `match_queue` fue eliminada vía `mcp__supabase__apply_migration`
-- ("drop_legacy_match_queue_table"). Era 100% legacy de la era WhatsApp/Baileys, sin escrituras
-- nuevas desde el pivot a matching 100% web (KAN-64). Las 9 filas reales que tenía se respaldaron
-- (no se migraron — shape incompatible con el modelo cross-tenant) en
-- docs/evolucion_proyecto/match_queue_backup_2026-07-29.md antes del DROP TABLE.
-- Reemplazada por `public.blind_matches` (ver más abajo), que persiste de verdad el resultado
-- del matching ciego cross-tenant (`src/services/blindMatching.ts`), algo que match_queue nunca
-- hizo para ese flujo.

CREATE TABLE public.blind_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.profiles(id),         -- buscador, dueño de la fila (RLS)
  search_id uuid REFERENCES public.active_searches(id) ON DELETE SET NULL,
  matched_tenant_id uuid NOT NULL REFERENCES public.profiles(id), -- dueño de la propiedad matcheada
  raw_search_text text NOT NULL,
  property_snapshot jsonb NOT NULL,  -- snapshot desnormalizado (domicilio/precio/moneda/dormitorios/...),
                                      -- no FK a properties: un match histórico no debe cambiar/romperse
                                      -- si el otro tenant edita o borra su propiedad después.
  searcher_snapshot jsonb NOT NULL,  -- {full_name, phone_number, agency_name, email} del buscador, congelado
                                      -- al momento del match, para que el dueño de la propiedad
                                      -- matcheada pueda contactarlo sin depender de que el buscador
                                      -- mire a tiempo su notificación/email (gap identificado en KAN-78).
  score double precision NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_review_status text NOT NULL DEFAULT 'PENDING' CHECK (user_review_status IN ('PENDING','ACCEPTED','REJECTED')),
  feedback_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_blind_matches_tenant_created ON public.blind_matches (tenant_id, created_at DESC);
CREATE INDEX idx_blind_matches_matched_tenant_created ON public.blind_matches (matched_tenant_id, created_at DESC);

-- RLS: dos policies, no una — el buscador (tenant_id) tiene control total (incluye curar
-- user_review_status/feedback_reason vía POST /api/matches/:id/feedback); el dueño de la
-- propiedad matcheada (matched_tenant_id) solo puede LEER (GET /api/matches/incoming), nunca
-- editar el match ajeno.
ALTER TABLE public.blind_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blind_matches_tenant_isolation" ON public.blind_matches
  FOR ALL TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "blind_matches_matched_tenant_read" ON public.blind_matches
  FOR SELECT TO authenticated
  USING (matched_tenant_id = auth.uid());

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
--   latitude double precision NULL, longitude double precision NULL (sin default — eran NOT NULL
--   desde KAN-63, con 0/0 como fallback silencioso del código; migración "make_properties_lat_lng_nullable"
--   de KAN-80 las vuelve nullable: `null` ahora significa "geocoding falló", ver GeocodingService
--   en src/services/geocoding.ts y syncPropertiesToDatabase en excel.ts),
--   location geometry (PostGIS, nullable, no usada aún por resolvePropertyZoneId()),
--   created_at timestamptz DEFAULT timezone('utc', now())
--
-- ADENDA DE SEGURIDAD (2026-07-02, sesión posterior a spec_0014):
-- RLS ya está HABILITADO vía mcp__supabase__apply_migration, migración
-- "enable_rls_tenant_isolation":
--   - profiles: FOR ALL TO authenticated USING/WITH CHECK (id = auth.uid())
--   - properties, whatsapp_sessions (eliminada en KAN-64): FOR ALL TO authenticated
--     USING/WITH CHECK (tenant_id = auth.uid())
--   - blind_matches (KAN-78, reemplaza a match_queue, eliminada): ver política propia más arriba
--     (tenant_id = auth.uid() para todo, matched_tenant_id = auth.uid() solo lectura)
--   - neighborhood_groups/neighborhoods/neighborhood_aliases: RLS habilitado,
--     sin políticas (deny-all) — leídas solo por src/services/zonesService.ts (KAN-85, ver
--     entry en CONTEXT.md sección 5) con el cliente service-role, que bypassea RLS. No son
--     datos de tenant: es taxonomía compartida de solo lectura, deny-all es intencional para
--     bloquear acceso directo vía anon/authenticated key.
--
-- public.neighborhood_groups (KAN-85, poblada — 4 filas): id uuid PK, name text UNIQUE,
--   description text nullable, created_at. Agrupa neighborhoods por heurística de prefijo de
--   nombre ('Zonas', 'Barrios', 'Countries y Barrios Privados', 'Otros / Puntos de Interés') —
--   zones.ts no tenía agrupación explícita, se infirió del nombre de cada zona.
--
-- public.neighborhoods (KAN-85, poblada — 189 filas, 1:1 con las 189 zonas de
--   src/utils/constants/zones.ts): id uuid PK, group_id uuid FK -> neighborhood_groups
--   (ON DELETE SET NULL, nullable), name text UNIQUE (mismo string que la key de zones.ts,
--   ej. "ZONA_MATE_DE_LUNA"), boundary geometry(Polygon, 4326) NOT NULL (índice GiST
--   idx_neighborhoods_spatial_boundary), created_at. Datos migrados y validados con
--   scripts/gen-neighborhoods-migration.ts (script generador, no desechado — vuelve a correr
--   si zones.ts cambia) + reparación manual post-seed de 4 polígonos con auto-intersección
--   real (bowtie) detectada vía ST_IsValid/ST_MakeValid, no detectable por el generador (no
--   corre GEOS). SQL aplicado íntegro en
--   docs/evolucion_proyecto/neighborhoods_seed_kan85_2026-07-30.sql. 0 anomalías de
--   cierre-de-anillo o fuera de bounding box tras la limpieza automática del generador.
--
-- public.neighborhood_aliases (KAN-85, poblada — 21 filas): id uuid PK, neighborhood_id uuid
--   FK -> neighborhoods (ON DELETE CASCADE), alias text UNIQUE global (un alias mapea a un
--   único neighborhood), índice btree sobre lower(alias). Migrados 1:1 solo los keywords NO
--   ambiguos de classifyPropertyZoneId (src/utils/matcher.ts) — se excluyó a propósito el
--   bloque `centroKeywords` (santiago/corrientes/laprida/...), que en el código original
--   resuelve a ZONA_CENTRO o BARRIO_NORTE según una condición secundaria compuesta,
--   irrepresentable como alias 1:1 con un UNIQUE global sobre `alias`; queda documentado en
--   el SQL de seed para quien integre esto a resolvePropertyZoneId() a futuro. Anomalía real
--   corregida en los datos: el keyword legacy 'san pablo' resolvía a YERBA_BUENA pese a
--   existir un polígono SAN_PABLO propio y más preciso — el alias ahora apunta a SAN_PABLO.
--
-- public.neighborhood_for_point(lat double precision, lon double precision) (KAN-85, función
--   SQL SECURITY DEFINER, solo EXECUTE para service_role): resuelve qué neighborhood contiene
--   un punto vía ST_Contains, consumida por zonesService.ts#findNeighborhoodByPoint(). Sin
--   invocadores en src/ todavía más allá de zonesService — no está enganchada a
--   resolvePropertyZoneId()/matcher.ts (ver deuda técnica "Matching espacial PostGIS" en
--   CONTEXT.md sección 5, deliberadamente fuera de alcance de KAN-85, que es solo
--   taxonomía/datos, no el reemplazo del motor de matching en vivo).
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
-- `status` sin especificar sus valores ni el tipo de `criteria`).
--
-- Primer código consumidor (KAN-37, 2026-07-28): `POST /api/search` (src/index.ts) inserta acá
-- vía req.supabaseClient (tenant-scoped), con `criteria` = el `ExtractedRealEstateRequest` que
-- devuelve `extractFromTextInput` tal cual (JSON.stringify de la interfaz TS). El motor de
-- matching (src/services/blindMatching.ts) sólo LEE `properties` cross-tenant en esa dirección
-- (búsqueda→cartera); no hay código todavía que recorra `active_searches` de otros tenants para
-- la dirección inversa (cartera→búsqueda) ni que transicione `status` a 'matched'/'expired'.
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
--
-- KAN-79 (2026-07-30): dirección cartera->búsqueda del matching bidireccional — hasta acá,
-- `active_searches` solo se leía en la dirección búsqueda->cartera (KAN-37/38/39, `criteria`
-- comparado en memoria contra properties de otros tenants). Cambios: `blind_matches` gana
-- `property_id uuid` (nullable, SIN FK a properties — mismo criterio de KAN-78, solo para dedup
-- de `POST /internal/property-match-check`) + índice parcial `idx_blind_matches_dedup
-- (search_id, property_id) WHERE property_id IS NOT NULL`. Nuevos índices de expresión sobre
-- `active_searches`: `idx_active_searches_criteria_operation`/`idx_active_searches_criteria_
-- property_type` sobre `(criteria->>'operation')`/`(criteria->>'property_type')` WHERE
-- status='active' — prefiltro SQL para `findMatchingActiveSearchesForProperty`
-- (src/services/blindMatching.ts), simétrico a `idx_properties_meta_filters` del otro lado.
--
-- Extensión nueva: `pg_net` (async HTTP desde Postgres). Función `public.notify_property_uploaded()`
-- (SECURITY DEFINER, `search_path` fijo, EXECUTE revocado a PUBLIC/anon/authenticated — ver
-- docs/evolucion_proyecto/kan79_bidirectional_trigger_2026-07-30.sql) + trigger
-- `property_uploaded_trigger` (AFTER INSERT ON properties, no UPDATE — decisión explícita)
-- disparan `net.http_post` hacia `POST /internal/property-match-check` (endpoint nuevo en
-- src/index.ts, sin sesión de usuario, protegido por un secreto compartido) cada vez que entra
-- una propiedad nueva — 100% async, no bloquea el INSERT de /api/upload. Secreto y APP_URL viven
-- en Supabase Vault (`internal_webhook_secret`/`app_url`, no en un GUC — `ALTER DATABASE ... SET
-- app.settings.*` no está permitido para el rol de migraciones de este proyecto gestionado).
-- **APP_URL sigue en el placeholder `http://localhost:3000`** — actualizar en Vault antes de
-- confiar en el trigger contra producción real (ver el .sql de arriba para el comando exacto).
