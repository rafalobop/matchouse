-- KAN-318: comentarios SQL (COMMENT ON TABLE) que documentan, directamente en el catálogo de
-- Postgres, que el RLS "habilitado sin políticas" (deny-all) de estas tablas es una decisión de
-- diseño intencional — no un olvido de agregar policies. Sin este comentario, un advisor de
-- Supabase (`rls_enabled_no_policy`) o alguien inspeccionando el schema por primera vez no tiene
-- forma de distinguir "deny-all a propósito" de "policy pendiente de escribir". Mismo hallazgo ya
-- evaluado y confirmado como bajo riesgo/intencional en KAN-76 (ver `.agent/CONTEXT.md`).
--
-- Contexto completo (por qué cada tabla es deny-all) documentado en
-- `docs/rls-deny-all-tables-README.md` — este archivo solo aplica los comentarios al catálogo
-- real de Postgres, visible vía `\d+ <tabla>`, `information_schema.tables` o el dashboard de
-- Supabase, sin depender de que alguien conozca este repo.

COMMENT ON TABLE public.licensed_agents IS
  'RLS habilitado sin policies (deny-all) INTENCIONAL, no pendiente. Caché local del padrón '
  'público de matriculados del Colegio de Corredores Inmobiliarios de Tucumán (KAN-306,'
  ' docs/evolucion_proyecto/add_license_validation_2026-09-01.sql) — no es tenant-scoped, es un'
  ' catálogo de referencia compartido de solo uso server-side (src/services/licenseRegistry.ts)'
  ' via cliente service-role, que bypassea RLS. Ni anon ni authenticated deben poder leer/escribir'
  ' esta tabla via PostgREST directo. Ver docs/rls-deny-all-tables-README.md para el proceso de'
  ' revisión periódica.';

COMMENT ON TABLE public.neighborhood_groups IS
  'RLS habilitado sin policies (deny-all) INTENCIONAL, no pendiente. Taxonomía compartida de solo'
  ' lectura (KAN-85) — leída solo por src/services/zonesService.ts con el cliente service-role,'
  ' que bypassea RLS. No son datos de tenant, deny-all bloquea acceso directo vía anon/authenticated'
  ' key. Ver docs/rls-deny-all-tables-README.md para el proceso de revisión periódica.';

COMMENT ON TABLE public.neighborhoods IS
  'RLS habilitado sin policies (deny-all) INTENCIONAL, no pendiente. Taxonomía compartida de solo'
  ' lectura (KAN-85) — leída solo por src/services/zonesService.ts con el cliente service-role,'
  ' que bypassea RLS. No son datos de tenant, deny-all bloquea acceso directo vía anon/authenticated'
  ' key. Ver docs/rls-deny-all-tables-README.md para el proceso de revisión periódica.';

COMMENT ON TABLE public.neighborhood_aliases IS
  'RLS habilitado sin policies (deny-all) INTENCIONAL, no pendiente. Taxonomía compartida de solo'
  ' lectura (KAN-85) — leída solo por src/services/zonesService.ts con el cliente service-role,'
  ' que bypassea RLS. No son datos de tenant, deny-all bloquea acceso directo vía anon/authenticated'
  ' key. Ver docs/rls-deny-all-tables-README.md para el proceso de revisión periódica.';
