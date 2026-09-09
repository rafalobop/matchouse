---
name: langgraph-dev-team-scaffolder
description: Scaffolds a node (or the full graph) of a multi-agent software-development LangGraph — Product Owner, PM/EM/Tech Lead debate, Task Creation, Developer, or QA — including the shared state schema, node function, tool bindings, and edges/conditional routing. Use this skill whenever the user asks to design, scaffold, add, or wire up a node or edge in their dev-team LangGraph, asks "how do I structure the state for X node", asks to connect a new role to the graph, or wants a base structure to keep iterating on. Trigger even if they just name the role (e.g. "necesito el nodo QA") without saying "scaffold" explicitly.
---

# LangGraph dev-team scaffolder

Genera la estructura base (state, node, tools, edges) de un grafo LangGraph que simula un equipo de desarrollo de software: Product Owner → PM/EM/Tech Lead → Task Creation → Developer → QA → cierre.

No escribas lógica de negocio del producto del usuario. Esta skill es sobre la **arquitectura del grafo de agentes**, no sobre qué hace la app que están construyendo.

## Paso 0 — Contexto del proyecto

Antes de generar nada, revisá el repo (si estás corriendo en Claude Code):

1. Buscá si ya existe un archivo de estado del grafo (`graph/state.ts`, `agents/state.ts`, etc.) o un `CONTEXT.md` / `.agent/skills/*` con convenciones ya definidas. Si existe, **extendé ese archivo, no lo dupliques.** En este repo el grafo vive en `langgraph-tools/src/graph/` (workspace separado del producto, ver KAN-320) — no lo generes dentro de `src/` de `brokaza`.
2. Confirmá el lenguaje/módulo del proyecto (por defecto: TypeScript, CommonJS, `pnpm`, LangGraph.js — si el `tsconfig.json` dice otra cosa, seguí eso).
3. Si no hay nada todavía, esto es la primera pieza del grafo: empezá por el state schema (paso 1) antes que por cualquier nodo.
4. Este proyecto corre 100% local y no se sube a git — no agregues advertencias de "no comitear credenciales" ni generes `.env.example`; las claves ya viven en `.env` local y se referencian por nombre de variable, nada más.

Si algo de esto no está claro, preguntá en una sola tanda antes de escribir código — no asumas.

## Paso 1 — Definir o extender el state schema

El state es lo único que todos los nodos comparten. Definilo una sola vez, en un solo archivo (`graph/state.ts`), y que cada nodo lea/escriba únicamente los campos que le corresponden.

Campos mínimos recomendados para este tipo de grafo:

```typescript
interface DevTeamState {
  // Entrada
  rawIdea: string;

  // Producto de Product Owner
  spec: {
    title: string;
    problem: string;
    proposedSolution: string;
    openQuestions: string[];
    status: "draft" | "reviewed" | "approved";
  } | null;

  // Aportes de cada rol, generados en paralelo (fan-out) sin verse entre sí.
  // Cada uno es resultado de un debate interno proposer/opposer del propio rol (ver Paso 2).
  roleInputs: {
    pm: { concerns: string[]; priorities: string[]; selfCritique: string } | null;
    em: { feasibility: string; risks: string[]; resourcing: string; selfCritique: string } | null;
    techLead: { approach: string; tradeoffs: string[]; risks: string[]; selfCritique: string } | null;
  };

  // Conflictos que el judge detectó entre roles y cómo los resolvió
  conflictsResolved: Array<{ issue: string; resolution: string }>;

  // Síntesis final, generada por el nodo de síntesis a partir de roleInputs
  plan: {
    approach: string;
    risks: string[];
    tradeoffs: string[];
    approvedBy: string[]; // qué roles dieron el ok
  } | null;

  // Tareas generadas
  tasks: Array<{
    id: string;
    title: string;
    definitionOfDone: string;
    acceptanceCriteria: string[];
    assignee: "dev" | "qa";
    status: "todo" | "in_progress" | "in_review" | "done" | "blocked";
  }>;

  // Resultado de QA sobre la última corrida
  qaResult: {
    passed: boolean;
    failedCriteria: string[];
    evidence: string; // output real de test, no un resumen inventado
  } | null;

  // Qué tiene que corregir el dev en un retry — SOLO esto, nada más del resto del código
  correctionFocus: string[] | null;

  // Control de loop
  retryCount: number;
  maxRetries: number; // fijo en 3 para este proyecto
}
```

Ajustá los campos a lo que el usuario ya tenga (por ejemplo, si ya existen tipos de `match_queue` u otras entidades del dominio, no los repitas acá — el state del grafo es sobre el *proceso*, no sobre las entidades del producto).

## Paso 2 — Scaffoldear un nodo

Para cada nodo, generá tres cosas juntas: función del nodo, tools que necesita, y edge(s) de salida. Usá esta plantilla y completala según el rol pedido.

```typescript
// graph/nodes/<nombre-del-nodo>.ts
import { DevTeamState } from "../state";

export async function <nombreDelNodo>Node(
  state: DevTeamState
): Promise<Partial<DevTeamState>> {
  // 1. Armar el prompt específico del rol a partir del state actual
  // 2. Llamar al modelo (con las tools bindeadas que correspondan a este rol)
  // 3. Parsear la respuesta a la forma del campo de state que este nodo produce
  // 4. Devolver SOLO el delta de state (LangGraph mergea)
  return {
    /* campo actualizado */
  };
}
```

### Guía específica por rol

**Product Owner**
- Input: `state.rawIdea`
- Output: `state.spec`
- Tools típicas: ninguna, o lectura de specs previas si las tenés indexadas. No necesita filesystem ni ejecución de código.
- Edge de salida: siempre avanza a PM/EM/Tech Lead (sin condición), salvo que definas un criterio de "idea insuficiente" que vuelva a pedir más info al usuario.

**PM / EM / Tech Lead — debate paralelo (proposer + opposer internos), con Judge que arbitra**

Estos 3 nodos corren **en paralelo** (fan-out desde `poNode`), sin verse entre sí — cada uno arma su postura de forma independiente. Como no se ven, sus outputs pueden pisarse o contradecirse; por eso el 4to nodo no es una síntesis pasiva, es un **judge** que arbitra activamente.

Cada uno de los 3 nodos (`pmNode`, `emNode`, `techLeadNode`) hace internamente 3 llamadas secuenciales al modelo — esto SÍ es seguro (a diferencia de mezclar 3 roles distintos en una llamada): son 3 llamadas separadas, cada una con instrucción clara, dentro del mismo rol:

1. **Proposer**: a partir de `state.spec`, arma la postura inicial del rol (para PM: prioridades y concerns de negocio/usuario; para EM: viabilidad y resourcing; para Tech Lead: approach técnico).
2. **Opposer**: recibe esa postura y la ataca activamente — busca puntos débiles, casos borde no contemplados, supuestos frágiles. Instrucción explícita de ser crítico, no complaciente.
3. **Reconcile**: toma proposer + opposer y produce la postura final del rol, incorporando lo que la crítica reveló. Esto llena `state.roleInputs.<rol>`, incluyendo `selfCritique` con el punto más fuerte que el opposer encontró (aunque no haya cambiado la conclusión).

Tools típicas: ninguna en los 3 nodos.

**`judgeNode`** (antes `planSynthesisNode`) — Input: `state.roleInputs` completo, recién disponible cuando los 3 terminaron (fan-in). Output: `state.plan` + `state.conflictsResolved`.
- Este nodo es el único punto del grafo donde se resuelven contradicciones entre roles (ej: PM prioriza alcance completo, EM dice que no es viable en el tiempo — el judge decide y lo deja explícito en `conflictsResolved`, no lo esconde).
- No es "promediar" las 3 posturas — es decidir. `plan.approach` tiene que ser una decisión concreta, no una lista de opciones sin resolver.
- Tools típicas: ninguna, es puramente de arbitraje sobre el state.

Edges: `poNode → pmNode`, `poNode → emNode`, `poNode → techLeadNode` (fan-out, las 3 en paralelo) → `judgeNode` (fan-in: LangGraph no lo corre hasta que las 3 ramas completaron) → `taskCreationNode`.

**Task Creation**
- Input: `state.plan`
- Output: `state.tasks`
- Integración: Jira, tablero `matchouse`. Credenciales ya resueltas en `.env`: `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_PROJECT_KEY`, `ATLASSIAN_API_KEY`. Auth básica `email:token` (Jira Cloud usa el API token como password, no el token solo).
- Tool base para la creación de issues:

```typescript
// graph/tools/jira.ts
async function createJiraIssue(task: {
  title: string;
  definitionOfDone: string;
  acceptanceCriteria: string[];
}) {
  const auth = Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.ATLASSIAN_API_KEY}`
  ).toString("base64");

  const res = await fetch(
    `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          project: { key: process.env.JIRA_PROJECT_KEY },
          summary: task.title,
          issuetype: { name: "Task" },
          description: {
            type: "doc",
            version: 1,
            content: [
              /* DoD + acceptance criteria en formato Atlassian Document Format */
            ],
          },
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Jira create issue falló: ${res.status} ${await res.text()}`);
  return res.json(); // incluye el id/key del issue creado, guardalo en tasks[].id
}
```

- El body de `description` en Jira Cloud requiere Atlassian Document Format (no markdown plano) — completá ese bloque cuando armes el nodo real, no lo dejes como texto simple o la API lo rechaza.
- Edge de salida: a Developer.

**Developer**
- Input: la primera tarea en `state.tasks` con `status: "todo"`, **o**, si `state.correctionFocus` no es `null`, la tarea en `in_review` que rebotó de QA.
- Modo normal (`correctionFocus` es `null`): implementa la tarea completa según su `definitionOfDone` y `acceptanceCriteria`.
- Modo corrección (`correctionFocus` tiene contenido): el prompt de este nodo debe restringir explícitamente el trabajo a **solo** los items de `correctionFocus` — no tocar código fuera de esos puntos, no "aprovechar" para refactorizar otra cosa. Al terminar, limpiá `correctionFocus` a `null` antes de pasar a QA.
- Output: actualiza esa tarea a `in_review`, produce el código (side effect fuera del state, en el filesystem)
- Tools típicas: si corre como Claude Code — Read/Write/Edit/Bash/git ya vienen dados. Si corre como llamada directa a la API, bindeá filesystem tools + una tool de "correr comando" acotada.
- Edge de salida: a QA, siempre.

**QA**
- Input: la tarea en `in_review` + su `acceptanceCriteria`
- Output: `state.qaResult`. Si `passed` es `false`, este mismo nodo escribe también `state.correctionFocus = qaResult.failedCriteria` e incrementa `state.retryCount`. Si `passed` es `true`, dejá `correctionFocus: null`.
- Tools típicas: tool para ejecutar tests reales (`pnpm test`) y capturar el output crudo como `evidence` — nunca aceptes un resumen sin evidencia, igual que definiste en tu propio brief de verificación.
- Edge de salida: **condicional** (ver paso 3).

## Paso 3 — Edges y routing condicional

Los edges lineales (PO → [PM,EM,TechLead] fan-out → Judge fan-in → Tasks → Dev → QA) se definen con `.addEdge(a, b)` — el fan-out son 3 `.addEdge` con el mismo origen, el fan-in son 3 `.addEdge` con el mismo destino. El único punto de decisión condicional real del grafo es la salida de QA:

```typescript
// maxRetries: 3 — a los 3 rebotes de QA, corta el loop y marca la tarea como bloqueada
// en vez de intentar de nuevo indefinidamente. Un bloqueo real necesita ojo humano,
// no un cuarto intento del mismo agente.
function routeAfterQA(state: DevTeamState): "developer" | "close" {
  if (state.qaResult?.passed) return "close";
  if (state.retryCount >= state.maxRetries) return "close"; // corta el loop, marca como bloqueada
  return "developer";
}

graph.addConditionalEdges("qa", routeAfterQA, {
  developer: "developer",
  close: "close",
});
```

En `close`, si se llegó ahí por `retryCount >= maxRetries` (no por QA aprobado), el nodo de cierre (PO/PM) debe marcar la tarea como `"blocked"` en vez de `"done"` y dejar en la traza cuál fue el último `correctionFocus` sin resolver — eso es lo que un humano necesita ver para intervenir.

## Paso 5 — Cómo testear cada nodo antes de correr el grafo completo

No corras el grafo entero de punta a punta como primera prueba — si algo falla no vas a saber qué nodo fue. Testeá de adentro hacia afuera:

1. **Cada nodo aislado, con fixtures.** Para cada nodo, escribí un `state` de prueba a mano (no generado por el nodo anterior) y llamá la función del nodo directo, sin pasar por el grafo. Ej: para `judgeNode`, armá un `roleInputs` fixture donde a propósito PM y EM se contradigan, y verificá que `conflictsResolved` realmente lo capture — no que el judge lo ignore.
2. **El fan-out/fan-in, aislado del resto.** Armá un sub-grafo de 4 nodos (`poNode → [pmNode, emNode, techLeadNode] → judgeNode`) y corré eso solo, con un `rawIdea` fijo. Confirmá que `judgeNode` no arranca hasta que los 3 terminaron (podés forzarlo agregando un `console.log` con timestamp en cada nodo mientras probás).
3. **El loop QA↔Dev, aislado.** Armá un sub-grafo `devNode → qaNode` con una tarea trivial y un test que sabés que va a fallar la primera vez a propósito, para confirmar que `correctionFocus` se llena bien, que el dev en el segundo paso realmente se restringe a eso, y que a la 3ra vuelta corta a `blocked` en vez de reintentar.
4. **Recién ahí, el grafo completo**, con un `rawIdea` real simple (algo chico, no una feature completa) y mirando el state completo al final, no solo el resultado.

Para inspeccionar qué pasa en cada paso mientras corre el grafo completo, usá `.stream()` en vez de `.invoke()` — te da el delta de state que devuelve cada nodo a medida que se ejecuta, en vez de solo el resultado final. Es la forma más rápida de ver si el judge realmente está arbitrando o si algún rol está devolviendo `null`.

## Paso 6 — Qué entregar al usuario

Cuando generes el scaffold, entregá siempre junto:
1. El archivo de state (nuevo o el diff sobre el existente).
2. El/los archivo(s) de nodo pedidos.
3. La línea de wiring en el archivo del grafo (`addNode`, `addEdge`/`addConditionalEdges`).
4. Un resumen corto de qué falta decidir. Jira ya está resuelto (las 4 variables de entorno existen); lo que sigue pendiente es a criterio de cada nodo puntual que se scaffoldee (ej: qué campo exacto de Jira mapea `acceptanceCriteria`).

No generes todos los nodos del grafo de una si te piden solo uno (con el fan-out del debate, ahora son 9: PO, PM, EM, Tech Lead, Judge, Task Creation, Dev, QA, cierre) — scaffoldeá lo pedido y dejá comentarios `// TODO:` donde el usuario tenga que decidir algo específico de su dominio.