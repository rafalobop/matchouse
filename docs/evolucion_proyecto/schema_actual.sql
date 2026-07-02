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
-- public.profiles (RLS deshabilitado):
--   id uuid PK (FK -> auth.users.id), full_name text, email text UNIQUE,
--   created_at timestamptz DEFAULT timezone('utc', now())
--
-- public.properties (RLS deshabilitado):
--   id uuid PK DEFAULT gen_random_uuid(), tenant_id uuid (FK -> profiles.id),
--   address text, floor text, unit text, block text, lot text,
--   operation text CHECK (operation IN ('compra','alquiler','venta')),
--   property_type text CHECK (property_type IN ('departamento','casa','terreno','local','oficina','otro')),
--   price double precision, currency text CHECK (currency IN ('USD','ARS')),
--   maintenance_fees double precision DEFAULT 0, bedrooms integer DEFAULT 0,
--   features text, contact_info text, sheet_name text,
--   latitude double precision, longitude double precision,
--   location geometry (PostGIS, nullable, no usada aún por resolvePropertyZoneId()),
--   created_at timestamptz DEFAULT timezone('utc', now())
--
-- ADVERTENCIA DE SEGURIDAD (fuera de alcance de esta ronda, solo se deja constancia):
-- Row Level Security está DESHABILITADO en las 8 tablas de public (incl. match_queue,
-- properties, profiles, whatsapp_sessions) — expuestas por completo a las claves
-- anon/authenticated de Supabase. No se aplica remediation aquí porque activar RLS
-- sin políticas bloquearía todo acceso; queda reportado para que el usuario decida.
