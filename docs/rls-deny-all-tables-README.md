# RLS deny-all intencional: `licensed_agents` y la familia `neighborhood_*`

Este documento existe porque un advisor automático de Supabase (`rls_enabled_no_policy`) señala
estas tablas como "RLS habilitado sin ninguna policy" — que en la mayoría de los proyectos es un
error (RLS a medio configurar, nadie puede leer/escribir nada por accidente). **Acá es intencional
en las 4 tablas de abajo:** ninguna necesita policies porque ningún cliente autenticado por
PostgREST (`anon`/`authenticated`) debe poder tocarlas directo — el único acceso real es
server-side, con el cliente `service-role` (que bypassea RLS por diseño de Supabase).

## Tablas cubiertas por este documento

| Tabla | Por qué es deny-all | Quién la lee/escribe |
|---|---|---|
| `public.licensed_agents` | Caché local del padrón público de matriculados del Colegio de Corredores Inmobiliarios de Tucumán (KAN-306). No es tenant-scoped — catálogo de referencia compartido, de solo uso interno. | `src/services/licenseRegistry.ts` (sync periódico por scraping) y la validación de matrícula en el registro (`src/controllers/profileController.ts`), ambos con cliente service-role. |
| `public.neighborhood_groups` | Taxonomía compartida de solo lectura (KAN-85) — agrupación de zonas, no datos de tenant. | `src/services/zonesService.ts`, cliente service-role. |
| `public.neighborhoods` | Polígonos PostGIS de las 189 zonas del sistema (KAN-85) — taxonomía compartida, no datos de tenant. | `src/services/zonesService.ts` (incluye la función SQL `neighborhood_for_point`, `SECURITY DEFINER`, solo `EXECUTE` para `service_role`). |
| `public.neighborhood_aliases` | Alias de texto → zona (KAN-85) — taxonomía compartida, no datos de tenant. | `src/services/zonesService.ts`, cliente service-role. |

Los comentarios SQL correspondientes (`COMMENT ON TABLE ...`) están en
`docs/evolucion_proyecto/add_deny_all_rls_comments_kan318_2026-09-08.sql` — quedan visibles
directamente en el catálogo de Postgres (`\d+ <tabla>`, `information_schema.tables`, o el
dashboard de Supabase → Table Editor → Comments) sin depender de que quien audite conozca este
repo.

## Cómo distinguir "deny-all intencional" de "policy que falta"

Antes de agregar una policy a cualquiera de estas 4 tablas porque un advisor lo señala, confirmar:

1. ¿El único código que lee/escribe la tabla usa el cliente **service-role** (`services/supabase.ts#supabase`, no `getTenantClient()`)? Si sí, agregar una policy no es necesario — el service-role ya bypassea RLS.
2. ¿La tabla contiene datos de un tenant específico (columna `tenant_id` o equivalente), o es taxonomía/catálogo compartido? Si es lo segundo, no hay "dueño" al que scopear una policy — deny-all es la postura correcta hasta que exista un caso real de acceso directo vía `anon`/`authenticated`.
3. Si la respuesta a 1 es "no" (apareció un caller nuevo usando `getTenantClient()` o la `anon key` contra alguna de estas tablas), **ese es el momento de escribir una policy real** — no antes. Actualizar este documento y el `COMMENT ON TABLE` en el mismo cambio.

## Proceso de revisión periódica

- **Cuándo:** cada vez que se corra una auditoría de seguridad del proyecto (ver
  `docs/sentry-security-audit.md` y las entries de auditoría en `.agent/CONTEXT.md`, sección
  "Deuda Técnica y Próximos Pasos Activos") — como mínimo, revisar este documento cuando el
  advisor `rls_enabled_no_policy` de Supabase vuelva a aparecer para alguna de estas 4 tablas.
- **Qué revisar:** que las 3 preguntas de la sección anterior sigan respondiéndose igual para cada
  tabla — en particular, que ningún código nuevo empezó a leerlas/escribirlas con
  `req.supabaseClient`/`getTenantClient()` en vez del cliente service-role (eso sí requeriría una
  policy real, ya no deny-all).
- **Quién:** `@backend` en la sesión que atienda el hallazgo del advisor, dejando constancia en el
  ticket de Jira correspondiente (mismo patrón que KAN-76, que evaluó y confirmó por primera vez
  esta lista de tablas como bajo riesgo).
- **Qué actualizar si cambia algo:** este archivo, el `COMMENT ON TABLE` de la tabla afectada (vía
  una migración nueva en `docs/evolucion_proyecto/`), y la entry correspondiente en
  `.agent/CONTEXT.md`.

## Tablas deny-all relacionadas, fuera del alcance de este documento

`admin_audit_log`, `admin_users` y `rate_limit_counters` también tienen RLS deny-all intencional
(mismo criterio, cliente service-role únicamente) — evaluadas y confirmadas en KAN-76
(`.agent/CONTEXT.md`), pero sin `COMMENT ON TABLE` propio todavía. No se tocaron en este documento
porque el ticket que lo originó (KAN-318) pedía específicamente `licensed_agents` y la familia
`neighborhood_*` — si se quiere extender el mismo tratamiento a esas 3 tablas, es un ticket aparte.
