-- KAN-319: revoca EXECUTE del rol anon sobre funciones SECURITY DEFINER que no deberían ser
-- invocables por un cliente no autenticado (PostgREST expone toda función marcada callable a
-- cualquier rol con EXECUTE, sin importar que sea SECURITY DEFINER — el DEFINER solo cambia con
-- qué privilegios corre el body, no quién puede llamarla).
--
-- Idempotente: REVOKE sobre un privilegio que un rol ya no tiene no es un error en Postgres, así
-- que este archivo puede correrse sin chequear primero el estado real de cada grant.
--
-- Las tres funciones ya tienen, en el repo, una migración previa que en teoría debería dejar a
-- anon sin EXECUTE (ver notas por función abajo) — pero, mismo patrón de drift ya documentado en
-- `.agent/CONTEXT.md` (KAN-64 sobre columnas de `profiles`, KAN-318 sobre migraciones "listas pero
-- no aplicadas" por falta de MCP de Supabase en la sesión que las escribió): no hay garantía de
-- que esas migraciones se hayan aplicado tal cual a la base real. Este archivo revoca de nuevo,
-- explícitamente, sin asumir el estado documentado.
--
-- 1) rate_limit_check(text, integer, integer) — src/utils/rateLimit.ts#createDistributedRateLimiter,
--    migración original `create_rate_limit_counters_table` (no versionada en este repo, aplicada
--    directo contra la base real en su momento — sin REVOKE/GRANT explícito documentado en ningún
--    lado del repo, a diferencia de las otras dos). Firma tomada de
--    src/types/database.types.ts#rate_limit_check (Args: p_key text, p_max_requests integer,
--    p_window_ms integer). Se llama vía `client.rpc('rate_limit_check', ...)` — el cliente que usan
--    los limiters distribuidos es el service-role (no hay tenant logueado en la mayoría de los
--    endpoints protegidos, ej. request-magic-link), así que anon no necesita EXECUTE acá.
REVOKE EXECUTE ON FUNCTION public.rate_limit_check(text, integer, integer) FROM anon;

-- 2) current_agency_owner_id() — docs/evolucion_proyecto/add_agency_shared_tenant_scope_2026-09-04.sql
--    ya tenía `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO authenticated;`, pero
--    add_collaborator_status_2026-09-04.sql (mismo día, posterior) vuelve a hacer
--    `CREATE OR REPLACE FUNCTION` sobre la misma función. CREATE OR REPLACE no resetea el ACL en
--    Postgres, así que en teoría el REVOKE ALL FROM PUBLIC previo sigue vigente — pero se revoca
--    de nuevo acá por las mismas razones de drift de la nota general de arriba. Usada en RLS de
--    `active_searches`, `web_push_subscriptions`, `tenant_excel_mappings`, `blind_matches` y
--    `properties` — solo debe ser ejecutable por `authenticated` (ya tiene ese GRANT explícito).
REVOKE EXECUTE ON FUNCTION public.current_agency_owner_id() FROM anon;

-- 3) neighborhood_for_point(double precision, double precision) —
--    docs/evolucion_proyecto/neighborhoods_seed_kan85_2026-07-30.sql ya tenía
--    `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO service_role;`. Se revoca de nuevo acá por
--    la misma razón de drift. Solo la consume src/services/zonesService.ts vía cliente
--    service-role — ni anon ni authenticated deben poder invocarla directo por PostgREST.
REVOKE EXECUTE ON FUNCTION public.neighborhood_for_point(double precision, double precision) FROM anon;
