# langgraph-tools

Workspace separado del producto Brokaza (KAN-320). Contiene dos piezas de tooling que antes vivían
mezcladas con el código de producto en `src/` y `scripts/`:

1. **`src/graph/`** — andamiaje de LangGraph del equipo de desarrollo simulado (PO → PM/EM/Tech Lead →
   Judge → Task Creation). Ver `.claude/skills/langgraph-dev-team-scaffolder/SKILL.md` (en el repo raíz)
   para el patrón que sigue esta scaffolding.
2. **`scripts/load-test-dashboard.ts`** — load test manual (WS + polling) del dashboard de Brokaza
   (KAN-128). Desechable, se corre a mano contra staging, no corre en CI.

Es un paquete standalone del pnpm workspace: no importa nada de `src/` ni `services/` del producto
(`brokaza`, en la raíz del repo) — tiene su propia config de entorno (`src/graph/env.ts`) y su propio
fallback de LLM (`src/graph/llm.ts`), para que el código fuente de Brokaza no dependa de esta scaffolding
ni viceversa.

## Setup

Instalar dependencias desde la raíz del repo (pnpm resuelve el workspace):

```
pnpm install
```

Variables de entorno (mismo `.env` de la raíz, dotenv las lee desde el cwd donde se ejecute el script):

- `GEMINI_API_KEY` (requerida) / `OPENAI_API_KEY` (opcional, fallback)
- `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_PROJECT_KEY`, `ATLASSIAN_API_KEY` — solo si se va a correr el grafo
  contra un ticket real (`poNode`/`taskCreationNode`)

## Uso

Desde `langgraph-tools/`:

```
pnpm graph:run              # corre el grafo de equipo de desarrollo end-to-end
pnpm load-test:dashboard    # ver el header del script para env vars requeridas (TARGET_URL, SESSION_TOKEN, etc.)
pnpm test                   # corre los tests de este workspace (tests/runner.ts)
pnpm build                  # tsc -> dist/
```

## Mantenimiento

- Si se agrega un nodo nuevo al grafo, va en `src/graph/nodes/`, se registra en `src/graph/graph.ts` y
  se le suma el test correspondiente en `tests/` + el import en `tests/runner.ts`.
- No reintroducir imports hacia `../../src/...` (código de Brokaza) — si un nodo necesita una utilidad
  compartida con el producto, se duplica acá (paquete pequeño, bajo mantenimiento) en vez de crear una
  dependencia cruzada entre workspaces.
- Este workspace no se buildea ni se despliega junto al producto (`tsc` en la raíz solo compila `src/`
  de `brokaza`) — es tooling de desarrollo, no llega a `dist/` de producción.
