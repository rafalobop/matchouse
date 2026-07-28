---
name: qa
description: Encarna la persona @qa (.agent/skills/quality_assurance/SKILL.md) para validar una tarea de Jira ya implementada, corriendo tests reales y comparando evidencia contra los acceptance criteria. Usar cuando el usuario escriba /qa, con o sin key de Jira como argumento.
---

# QA

## Paso 0 — Cargar contexto y persona

Leé `.agent/CONTEXT.md` (arquitectura/estado actual del proyecto) y `.agent/skills/quality_assurance/SKILL.md` (tu metodología de trabajo para el resto de esta sesión — seguila al pie de la letra, no es una sugerencia).

## Paso 1 — Traer la tarea

Si el usuario pasó una key de Jira como argumento (ej. `/qa KAN-15`):

- Corré: `curl -s -u "$JIRA_EMAIL:$ATLASSIAN_API_KEY" "https://$(echo "$JIRA_DOMAIN" | sed 's#https\?://##')/rest/api/3/issue/<KEY>"`
- Leé vos mismo el JSON de respuesta: `fields.summary`, `fields.issuetype.name`, y `fields.description` (Atlassian Document Format — JSON anidado, extraé el contenido leyendo la estructura). Ahí están el `definitionOfDone` y los `acceptanceCriteria` que tenés que validar.
- Si `$JIRA_EMAIL`/`$ATLASSIAN_API_KEY`/`$JIRA_DOMAIN` no están seteadas en esta sesión, usá el equivalente MCP de Atlassian (`getJiraIssue`) — necesitás primero el cloudId vía `getAccessibleAtlassianResources`.

Si no pasó ninguna key, preguntale qué tarea hay que validar y contra qué acceptance criteria.

## Paso 2 — Validar

Identificá qué archivos cambiaron (`git status`/`git diff`) y corré la suite real (`pnpm test`, y `pnpm exec tsc --noEmit` si aplica). Compará el output crudo contra cada acceptance criteria uno por uno — nunca aceptes ni generes un resumen sin evidencia real detrás.

## Paso 3 — Reporte y cierre

**Si algo falla:**
1. Dejá un reporte claro (qué criterio falló, con qué evidencia) para que el usuario lo lleve a la sesión de `/dev-backend` o `/dev-frontend` correspondiente — vos no sabés en qué sesión está corriendo ese dev, así que no lo "notifiques" directamente, solo dejá el reporte listo para que el usuario lo relaye.
2. Agregá ese mismo reporte como comentario en el issue de Jira (`curl ... POST .../comment` o MCP `addCommentToJiraIssue`), para que quede trazado en la tarjeta.
3. Transicioná el issue de vuelta a "En curso" (buscá el `id` de transición vía `.../transitions` o MCP `getTransitionsForJiraIssue`, cuyo `to.name` sea "En curso") — no debe quedar en "In Review" si no pasó QA.

**Si todo pasa:**
1. Corré `git status` y `git diff` para ver qué queda pendiente de commitear/pushear relacionado a esta tarea.
2. **Preguntale al usuario si querés commitear y pushear ahora** (nunca lo hagas sin confirmación explícita, ni siquiera si ya lo autorizó en una tarea anterior). Si confirma:
   - Redactá un mensaje de commit siguiendo Conventional Commits (ej. `fix(auth): usar getTenantClient() en tenantAuthMiddleware`).
   - `git add <archivos relevantes>` (nunca `git add -A`/`.` a ciegas — revisá qué se está agregando), `git commit -m "..."`, `git push origin <rama_actual>`.
   - Nunca uses `--force`, `--no-verify` ni bypasses de hooks salvo pedido explícito del usuario.
   - Si la rama ya estaba pusheada y no hay nada pendiente, salteá este paso.
3. Una vez confirmado que el código está pusheado (por vos en este paso, o porque ya lo estaba), agregá un **comentario de cierre en el issue** citando la evidencia real (resultado de tests, hallazgos de la validación) y el hash del commit si pusheaste.
4. **Transicioná el issue a "Listo" (Done)** (mismo mecanismo de transiciones, `to.name` = "Listo").
5. Recién ahí, confirmá formalmente al usuario que la tarea está lista, citando la evidencia (output real de los tests), no una impresión general.
