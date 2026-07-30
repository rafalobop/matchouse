-- KAN-79: Matching bidireccional real — dirección cartera->búsqueda vía trigger de Postgres +
-- pg_net (async). Aplicado contra el proyecto Supabase "matchouse" (bbadahhljpddlckyrmvi) el
-- 2026-07-30 vía mcp__supabase__apply_migration (2 migraciones: "kan79_bidirectional_matching_
-- trigger" y "kan79_revoke_public_execute_trigger_fn"). Este proyecto no trackea migraciones
-- locales (todo remote-only, ver nota de KAN-85) — este archivo es la copia documentada del SQL
-- real aplicado, con el secreto real REDACTADO (nunca commitear el valor real a git).
--
-- Contexto: KAN-37/38 (matching ciego búsqueda->cartera) dejó explícitamente fuera de alcance la
-- dirección inversa — cuando entra una propiedad NUEVA, nadie revisaba si matcheaba las
-- active_searches activas de OTROS tenants. Este ticket cierra ese gap con un trigger real de
-- Postgres (no polling desde la app), decisión confirmada con el usuario: async vía pg_net (no
-- bloquea el INSERT de /api/upload) y solo en INSERT (no UPDATE — una edición de propiedad
-- existente no se re-evalúa en este ticket).

-- === Migración 1: kan79_bidirectional_matching_trigger ===

CREATE EXTENSION IF NOT EXISTS pg_net;

-- Dedup: property_id es un identificador plano (NO FK a properties, a propósito — blind_matches
-- ya es un snapshot desnormalizado desde KAN-78, esto no cambia esa decisión), solo para que
-- processPropertyUploaded() (src/services/propertyMatchWebhook.ts) pueda saltear un
-- (search_id, property_id) ya persistido si el webhook se reintenta/entrega dos veces.
ALTER TABLE public.blind_matches ADD COLUMN IF NOT EXISTS property_id uuid;
CREATE INDEX IF NOT EXISTS idx_blind_matches_dedup ON public.blind_matches (search_id, property_id) WHERE property_id IS NOT NULL;

-- Prefiltro SQL sobre elementos indexables del lado de active_searches (AC1, dirección
-- cartera->búsqueda): mismo criterio que idx_properties_meta_filters del lado de properties.
-- Usado por findMatchingActiveSearchesForProperty (src/services/blindMatching.ts) vía .or() con
-- el comodín 'desconocido'/'otro' del Agente 1 (criteria.operation/property_type).
CREATE INDEX IF NOT EXISTS idx_active_searches_criteria_operation ON public.active_searches ((criteria->>'operation')) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_active_searches_criteria_property_type ON public.active_searches ((criteria->>'property_type')) WHERE status = 'active';

-- Secreto compartido de POST /internal/property-match-check (Node), guardado en Supabase Vault
-- (supabase_vault, ya instalado) porque es un bearer token real, no config — debe coincidir con
-- INTERNAL_WEBHOOK_SECRET en el .env/Railway del server Node.
-- select vault.create_secret('<REDACTADO — ver .env local / Railway>', 'internal_webhook_secret',
--   'KAN-79: secreto compartido de POST /internal/property-match-check, debe coincidir con INTERNAL_WEBHOOK_SECRET del server Node');

-- APP_URL: NO es secreto, pero el rol de migraciones de este proyecto Supabase gestionado NO tiene
-- permiso para `ALTER DATABASE ... SET app.settings.*` (probado: "permission denied to set
-- parameter") — se guarda en Vault igual que el secreto real, por simplicidad (un solo mecanismo
-- de lectura en la función del trigger). PENDIENTE: sigue en 'http://localhost:3000' (placeholder)
-- porque el usuario todavía no había desplegado/confirmado la URL real de Railway al momento de
-- este ticket — actualizar antes de confiar en el trigger en producción:
--   update vault.secrets set secret = 'https://<real>.railway.app' where name = 'app_url';
--   (o vault.update_secret(id, new_secret := '...') según la versión de la extensión)
select vault.create_secret('http://localhost:3000', 'app_url', 'KAN-79: URL pública usada por el trigger de properties para llamar a POST /internal/property-match-check. PLACEHOLDER — actualizar con la URL real de Railway antes de confiar en el trigger en producción.');

CREATE OR REPLACE FUNCTION public.notify_property_uploaded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  webhook_secret text;
  target_app_url text;
BEGIN
  SELECT decrypted_secret INTO webhook_secret FROM vault.decrypted_secrets WHERE name = 'internal_webhook_secret';
  SELECT decrypted_secret INTO target_app_url FROM vault.decrypted_secrets WHERE name = 'app_url';

  IF webhook_secret IS NOT NULL AND target_app_url IS NOT NULL THEN
    PERFORM net.http_post(
      url := target_app_url || '/internal/property-match-check',
      body := jsonb_build_object('property_id', NEW.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', webhook_secret)
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Solo INSERT (propiedad nueva) — decisión explícita confirmada con el usuario.
DROP TRIGGER IF EXISTS property_uploaded_trigger ON public.properties;
CREATE TRIGGER property_uploaded_trigger
  AFTER INSERT ON public.properties
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_property_uploaded();

-- === Migración 2: kan79_revoke_public_execute_trigger_fn ===
--
-- Hallazgo de mcp__supabase__get_advisors post-migración 1: notify_property_uploaded() es
-- SECURITY DEFINER y, al vivir en el schema public, Postgres le otorga EXECUTE a PUBLIC por
-- default — quedaba invocable vía /rest/v1/rpc/notify_property_uploaded por anon/authenticated.
-- Es una trigger function (RETURNS trigger): el motor de triggers la invoca sin necesitar que el
-- rol que dispara el INSERT tenga EXECUTE sobre ella, así que revocarlo no rompe el trigger
-- (confirmado empíricamente con el script de verificación desechable, ver más abajo), solo cierra
-- la superficie de RPC pública — mismo remedio que documenta el linter de Supabase para este
-- hallazgo (0028/0029_*_security_definer_function_executable).
REVOKE EXECUTE ON FUNCTION public.notify_property_uploaded() FROM PUBLIC, anon, authenticated;

-- === Verificación real (2026-07-30, script desechable src/verify-kan79.ts, borrado después de correr) ===
--
-- 2 tenants descartables (buscador + dueño) vía Admin API. El buscador crea una active_search
-- (venta/casa) con el cliente tenant-scoped real; el dueño inserta una propiedad NUEVA que
-- matchea con el cliente tenant-scoped real (dispara property_uploaded_trigger tal cual en
-- producción). Confirmado:
--   1. net._http_response registró una respuesta reciente (status 404, PGRST "Invalid path
--      specified in request URL") — la URL placeholder localhost:3000 resuelve DENTRO de la
--      infra de Supabase (a su propio PostgREST interno, no al server Node), así que la entrega
--      real falla, pero prueba sin ambigüedad que el trigger disparó y pg_net ejecutó un POST
--      saliente real con el payload/headers armados correctamente. Con APP_URL apuntando a la
--      URL real de Railway, este mismo POST llegaría al server Node.
--   2. Camino síncrono (llamando processPropertyUploaded() directo, sin pasar por pg_net):
--      matchesFound=1, matchesInserted=1, fila persistida en blind_matches con tenant_id/
--      matched_tenant_id/property_id correctos.
--   3. Dedup: un segundo llamado a processPropertyUploaded() con la misma propiedad da
--      matchesInserted=0/matchesSkippedDuplicate=1 (no duplica el aviso).
--   4. La notificación (push/email) se intentó para ambos lados con reintentos (3 intentos c/u,
--      visible en logs) — falló por la restricción real de la cuenta Resend sandbox
--      ("solo se puede enviar a la casilla dueña de la cuenta"), deuda técnica preexistente y ya
--      documentada en CONTEXT.md ("Dominio propio en Resend"), no un bug de este ticket.
-- Limpieza completa (blind_matches/active_searches/properties/profiles/auth.users de ambos
-- tenants) al finalizar el script.
