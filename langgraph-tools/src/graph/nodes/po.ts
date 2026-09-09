// graph/nodes/po.ts — Product Owner
// Input: state.jiraIssueKey (prioridad) o state.rawIdea (manual) | Output: state.spec

import * as fs from 'fs';
import * as path from 'path';
import { DevTeamState } from '../state';
import { generateStructuredJSON } from '../llm';
import { fetchJiraIssue } from '../jira';

// Se lee en cada carga del módulo (no se embebe como string) para que el
// comportamiento del nodo evolucione junto con .agent/skills/product_engineer/SKILL.md
// sin tener que tocar este archivo cuando cambie esa skill. KAN-320: un nivel más profundo
// que antes (langgraph-tools/src/graph/nodes/), la skill sigue centralizada en la raíz del repo.
const PRODUCT_ENGINEER_SKILL_PATH = path.join(
  __dirname,
  '../../../../.agent/skills/product_engineer/SKILL.md'
);

function loadProductEngineerSkill(): string {
  return fs.readFileSync(PRODUCT_ENGINEER_SKILL_PATH, 'utf-8');
}

export interface ResolvedSource {
  text: string;
  issueType: string | null; // ej. "Task" / "Story" cuando la fuente es Jira; null si es rawIdea manual
}

// jiraIssueKey tiene prioridad (es la key que el humano indicó corrida a corrida
// para la columna To Do del tablero); rawIdea sigue aceptándose como alternativa
// manual para test/smoke sin pegarle a Jira real.
export async function resolveSource(state: DevTeamState): Promise<ResolvedSource> {
  if (state.jiraIssueKey) {
    const issue = await fetchJiraIssue(state.jiraIssueKey);
    return {
      text: `Tipo de issue: ${issue.issueType}
Título: ${issue.summary}
Descripción: ${issue.descriptionText || '(sin descripción)'}`,
      issueType: issue.issueType
    };
  }

  if (state.rawIdea) {
    return { text: state.rawIdea, issueType: null };
  }

  throw new Error('poNode requiere state.jiraIssueKey o state.rawIdea — ninguno de los dos vino en el state.');
}

function buildSystemInstruction(issueType: string | null): string {
  const skill = loadProductEngineerSkill();

  const issueTypeNote = issueType
    ? `\nLa fuente de esta corrida es una issue de Jira de tipo "${issueType}" — tratala como corresponde: si es una "Story" es una historia de usuario (foco en valor/experiencia), si es una "Task" (u otro tipo técnico/operativo) es una tarea puntual (foco en el resultado concreto pedido). Ajustá el tono de "problem"/"proposedSolution" a ese tipo.\n`
    : '';

  return `Encarnás el rol "Product Owner" dentro de un grafo LangGraph que simula un equipo de desarrollo de software para el proyecto Brokaza.

Tu comportamiento y criterio como Product Owner están definidos por la siguiente skill (persona @product). Seguila al pie de la letra:

<PRODUCT_ENGINEER_SKILL>
${skill}
</PRODUCT_ENGINEER_SKILL>

Diferencia clave respecto a esa skill en su uso normal (Claude Code interactivo): acá NO hay una conversación iterativa turno a turno con el usuario humano — recibís el contenido una sola vez, dentro de <SOURCE>, y tenés que producir de una sola pasada la mejor especificación posible según los criterios de la skill. Si quedan ambigüedades que normalmente resolverías repreguntando, no las inventes: dejalas explícitas en "openQuestions".
${issueTypeNote}
No escribas código fuente de la aplicación (igual que dice la skill). Tu único entregable es la especificación estructurada.

Reglas de salida:
- Respondé ÚNICAMENTE con el JSON estructurado pedido, sin texto adicional.
- "status" debe ser "draft" si quedó alguna openQuestion sin resolver, o "reviewed" si la especificación quedó completa y sin ambigüedades pendientes. Nunca uses "approved" — esa transición la decide un humano o un nodo posterior, no el Product Owner.`;
}

function buildUserPrompt(sourceText: string): string {
  return `Analizá el siguiente contenido y generá la especificación estructurada, dentro de las etiquetas <SOURCE> y </SOURCE>:
<SOURCE>
${sourceText}
</SOURCE>`;
}

const SPEC_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'Título corto y concreto de la feature o hotfix' },
    problem: { type: 'STRING', description: 'Qué problema u oportunidad de negocio/usuario motiva esto' },
    proposedSolution: { type: 'STRING', description: 'Alcance funcional propuesto, en términos de producto, no de implementación técnica' },
    openQuestions: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Ambigüedades de alcance/reglas de negocio/casos de uso sin resolver' },
    status: { type: 'STRING', enum: ['draft', 'reviewed'] }
  },
  required: ['title', 'problem', 'proposedSolution', 'openQuestions', 'status']
};

const SPEC_OPENAI_SCHEMA = {
  name: 'product_owner_spec',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      problem: { type: 'string' },
      proposedSolution: { type: 'string' },
      openQuestions: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['draft', 'reviewed'] }
    },
    required: ['title', 'problem', 'proposedSolution', 'openQuestions', 'status'],
    additionalProperties: false
  }
};

export function normalizeSpec(raw: any): NonNullable<DevTeamState['spec']> {
  const status = raw?.status === 'reviewed' ? 'reviewed' : 'draft';

  return {
    title: typeof raw?.title === 'string' ? raw.title : '',
    problem: typeof raw?.problem === 'string' ? raw.problem : '',
    proposedSolution: typeof raw?.proposedSolution === 'string' ? raw.proposedSolution : '',
    openQuestions: Array.isArray(raw?.openQuestions) ? raw.openQuestions : [],
    status
  };
}

export async function poNode(state: DevTeamState): Promise<Partial<DevTeamState>> {
  const { text: sourceText, issueType } = await resolveSource(state);

  const rawSpec = await generateStructuredJSON({
    systemInstruction: buildSystemInstruction(issueType),
    userPrompt: buildUserPrompt(sourceText),
    geminiSchema: SPEC_GEMINI_SCHEMA,
    openaiSchema: SPEC_OPENAI_SCHEMA
  }, { primaryProvider: 'openai' });

  return {
    // Trazabilidad: queda registrado qué texto generó el spec, sea cual sea la
    // fuente (Jira o manual) — no rompe que rawIdea siga aceptándose como input.
    rawIdea: sourceText,
    spec: normalizeSpec(rawSpec)
  };
}

// Decisión: PO siempre avanza (edge sin condición), incluso con status "draft"
// y openQuestions sin resolver. La skill deja como opcional un criterio de
// "idea insuficiente" que pause el grafo a pedir más info — decidimos NO
// agregarlo acá: las openQuestions viajan dentro de spec y quedan visibles
// para PM/EM/TechLead y el Judge, que tienen más contexto para decidir si
// bloquean el avance o no. Evita meter interrupt()/checkpointer en el grafo
// antes de tener claro cómo se va a invocar completo.
