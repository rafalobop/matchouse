---
name: dev-frontend
description: Encarna la persona @frontend (.agent/skills/frontend_dev/SKILL.md) para implementar una tarea de Jira del lado de frontend. Usar cuando el usuario escriba /dev-frontend, con o sin key de Jira como argumento.
---

# Dev Frontend

## Paso 0 — Cargar contexto y persona

Leé `.agent/CONTEXT.md` (arquitectura/estado actual del proyecto) y `.agent/skills/frontend_dev/SKILL.md` (tu metodología de trabajo para el resto de esta sesión — seguila al pie de la letra, no es una sugerencia).

## Paso 0.1 — Cargar skills de stack (consistencia de desarrollo)

Este repo migra su frontend a Next.js/React (ver `MIGRATION_PLAN.md`), así que **siempre** cargá como contexto adicional, además de la persona `@frontend`:

| Skill | Instala (si no está ya) | Cuándo cargarla |
|---|---|---|
| `nextjs-app-router-patterns` (wshobson/agents) | `npx skills add wshobson/agents --skill nextjs-app-router-patterns` | Siempre — es el framework objetivo del frontend. Rutas, layouts, server vs. client components. |
| `react-state-management` (wshobson/agents) | `npx skills add wshobson/agents --skill react-state-management` | Siempre que la tarea implique estado (formularios, contexto de auth, cache de datos, store). Es obligatoria para cualquier ticket de Auth o Matches (§6 de `MIGRATION_PLAN.md`). |
| `supabase` (supabase/agent-skills) | `npx skills add supabase/agent-skills --skill supabase` | Solo si la tarea toca el flujo de magic-link / Supabase Auth (módulo Auth) o Storage. No hace falta para Upload/Matches/Admin salvo que la tarea lo mencione explícitamente. |

Si el comando `npx skills add ...` falla porque la skill ya está instalada, no es un error — seguí adelante, ya está disponible.

Esto replica el criterio de carga condicional por `detectedStack` documentado en `brokaza-dev-agents-graph.md` (§3): las skills de stack se cargan en el nodo Developer, no en Architecture Debate.

## Paso 1 — Traer la tarea y arrancarla

Si el usuario pasó una key de Jira como argumento (ej. `/dev-frontend KAN-15`):

- Corré: `curl -s -u "$JIRA_EMAIL:$ATLASSIAN_API_KEY" "https://$(echo "$JIRA_DOMAIN" | sed 's#https\?://##')/rest/api/3/issue/<KEY>"`
- Leé vos mismo el JSON de respuesta: `fields.summary` (título), `fields.issuetype.name`, y `fields.description` (viene en Atlassian Document Format — es JSON anidado con nodos `paragraph`/`text`/`bulletList`, no texto plano; extraé el contenido leyendo la estructura, no con un parser bash).
- Si `$JIRA_EMAIL`/`$ATLASSIAN_API_KEY`/`$JIRA_DOMAIN` no están seteadas en esta sesión, usá el equivalente MCP de Atlassian (`getJiraIssue`) — necesitás primero el cloudId vía `getAccessibleAtlassianResources`.

Si no pasó ninguna key, preguntale qué tarea hay que implementar.

**Transicioná la tarjeta a "En curso" (In Progress) antes de tocar código**, salvo que ya esté en curso o más adelante:

- Listá las transiciones disponibles: `curl -s -u "$JIRA_EMAIL:$ATLASSIAN_API_KEY" ".../rest/api/3/issue/<KEY>/transitions"` (o MCP `getTransitionsForJiraIssue`) y buscá el `id` cuyo `to.name` sea "En curso".
- Aplicá la transición: `curl -s -u "$JIRA_EMAIL:$ATLASSIAN_API_KEY" -X POST -H "Content-Type: application/json" -d '{"transition":{"id":"<id>"}}' ".../rest/api/3/issue/<KEY>/transitions"` (o MCP `transitionJiraIssue`).
- No hace falta pedir confirmación al usuario para este paso — es un cambio de estado reversible y de bajo riesgo.

## Paso 2 — Implementar

Seguí el `definitionOfDone` y `acceptanceCriteria` del ticket al pie de la letra. Conectate con los endpoints o la lógica que ya haya expuesto `@backend` (si la tarea depende de eso, pedile al usuario el resumen que le haya dejado esa sesión). Alcance: solo lo que pide el ticket — no aproveches para refactorizar algo fuera de foco.

Si el ticket es de complejidad **Alta** según §6 de `MIGRATION_PLAN.md` (Auth, o la UI de Matches), no arranques a codear directo: primero dejá por escrito el mini-diseño (estado global, descomposición de componentes, interceptor, etc.) y solo después de tenerlo claro empezá a implementar.

## Paso 2.5 — Self-check antes de pasar a QA

Corré `react-doctor` (`npx skills add millionco/react-doctor --skill react-doctor` si no está instalada) sobre el código que tocaste, antes de dar el ticket por terminado. Resolvé lo que encuentre o dejá justificado en el comentario del Paso 3 por qué no aplica — no se lo pasás a `@qa` con hallazgos de `react-doctor` sin atender.

## Paso 3 — Cierre

Antes de resumir al usuario, dejá constancia en la tarjeta de Jira:

1. **Agregá un comentario en el issue** con el resumen de lo implementado: qué archivos tocaste, qué decisiones de diseño tomaste (si las hubo) y qué necesita `@qa` para poder probarlo. Usá `curl -s -u "$JIRA_EMAIL:$ATLASSIAN_API_KEY" -X POST -H "Content-Type: application/json" -d '{"body": "..."}' ".../rest/api/3/issue/<KEY>/comment"` (el body va en Atlassian Document Format si usás curl crudo — si te resulta más simple, usá el MCP `addCommentToJiraIssue` con `commentBody` en markdown y listo).
2. **Transicioná el issue a "In Review" (En revisión)** con el mismo mecanismo de transiciones del Paso 1 (buscá el `id` cuyo `to.name` sea "In Review").

Recién ahí, resumí en pocas líneas al usuario: qué archivos tocaste y qué necesita `@qa` para poder probarlo. El usuario va a llevar ese resumen a la sesión de `/qa` manualmente.
