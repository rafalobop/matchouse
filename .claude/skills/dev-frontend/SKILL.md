---
name: dev-frontend
description: Encarna la persona @frontend (.agent/skills/frontend_dev/SKILL.md) para implementar una tarea de Jira del lado de frontend. Usar cuando el usuario escriba /dev-frontend, con o sin key de Jira como argumento.
---

# Dev Frontend

## Paso 0 — Cargar contexto y persona

Leé `.agent/CONTEXT.md` (arquitectura/estado actual del proyecto) y `.agent/skills/frontend_dev/SKILL.md` (tu metodología de trabajo para el resto de esta sesión — seguila al pie de la letra, no es una sugerencia).

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

## Paso 3 — Cierre

Antes de resumir al usuario, dejá constancia en la tarjeta de Jira:

1. **Agregá un comentario en el issue** con el resumen de lo implementado: qué archivos tocaste, qué decisiones de diseño tomaste (si las hubo) y qué necesita `@qa` para poder probarlo. Usá `curl -s -u "$JIRA_EMAIL:$ATLASSIAN_API_KEY" -X POST -H "Content-Type: application/json" -d '{"body": "..."}' ".../rest/api/3/issue/<KEY>/comment"` (el body va en Atlassian Document Format si usás curl crudo — si te resulta más simple, usá el MCP `addCommentToJiraIssue` con `commentBody` en markdown y listo).
2. **Transicioná el issue a "In Review" (En revisión)** con el mismo mecanismo de transiciones del Paso 1 (buscá el `id` cuyo `to.name` sea "In Review").

Recién ahí, resumí en pocas líneas al usuario: qué archivos tocaste y qué necesita `@qa` para poder probarlo. El usuario va a llevar ese resumen a la sesión de `/qa` manualmente.
