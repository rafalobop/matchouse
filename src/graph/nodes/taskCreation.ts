// graph/nodes/taskCreation.ts — Task Creation
// Input: state.plan (+ state.jiraIssueKey para decidir update vs create) | Output: state.tasks

import * as fs from 'fs';
import * as path from 'path';
import { DevTeamState } from '../state';
import { generateStructuredJSON } from '../llm';
import { formatSpecSummary } from '../debate';
import { buildTaskDescriptionAdf, createJiraIssue, updateJiraIssue } from '../jira';

const TASK_CREATION_SKILL_PATH = path.join(
  __dirname,
  '../../../.agent/skills/task_creation/SKILL.md'
);

function loadTaskCreationSkill(): string {
  return fs.readFileSync(TASK_CREATION_SKILL_PATH, 'utf-8');
}

function formatPlanSummary(plan: NonNullable<DevTeamState['plan']>): string {
  return `Approach: ${plan.approach}
Risks: ${plan.risks.length > 0 ? plan.risks.join(' | ') : '(ninguno)'}
Tradeoffs: ${plan.tradeoffs.length > 0 ? plan.tradeoffs.join(' | ') : '(ninguno)'}
Aprobado por: ${plan.approvedBy.length > 0 ? plan.approvedBy.join(', ') : '(nadie registrado)'}`;
}

function buildSystemInstruction(hasExistingJiraIssue: boolean): string {
  const skill = loadTaskCreationSkill();

  const modeNote = hasExistingJiraIssue
    ? 'Esta corrida SÍ tiene un ticket de Jira de origen — tu resultado va a enriquecer ese ticket existente (solo se actualiza su descripción). Igual generá un "title" corto, aunque en este modo no se use para renombrar el ticket.'
    : 'Esta corrida NO tiene ticket de Jira de origen — tu resultado va a crear un ticket nuevo desde cero, así que el "title" sí importa: tiene que ser corto y concreto.';

  return `Encarnás el rol "Task Creation" dentro de un grafo LangGraph que simula un equipo de desarrollo de software para el proyecto HouseMatch.

Tu comportamiento y criterio están definidos por la siguiente skill (persona @taskcreation). Seguila al pie de la letra:

<TASK_CREATION_SKILL>
${skill}
</TASK_CREATION_SKILL>

${modeNote}

No es una conversación con el usuario humano — no repreguntes, trabajá con la información que tenés.

Reglas de salida:
- Respondé ÚNICAMENTE con el JSON estructurado pedido, sin texto adicional.
- "acceptanceCriteria" tiene que ser una lista de afirmaciones verificables (sí/no), nunca vagas.`;
}

function buildUserPrompt(specSummary: string, planSummary: string): string {
  return `Especificación funcional, dentro de <SPEC>:
<SPEC>
${specSummary}
</SPEC>

Plan ya arbitrado por Judge, dentro de <PLAN>:
<PLAN>
${planSummary}
</PLAN>

Generá la definición de tarea.`;
}

const TASK_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'Título corto y concreto (solo se usa si se crea un ticket nuevo)' },
    definitionOfDone: { type: 'STRING', description: 'Resultado verificable de qué significa "terminado"' },
    acceptanceCriteria: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Afirmaciones concretas y verificables (sí/no)' }
  },
  required: ['title', 'definitionOfDone', 'acceptanceCriteria']
};

const TASK_OPENAI_SCHEMA = {
  name: 'task_definition',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      definitionOfDone: { type: 'string' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'definitionOfDone', 'acceptanceCriteria'],
    additionalProperties: false
  }
};

export function normalizeTaskDefinition(raw: any): { title: string; definitionOfDone: string; acceptanceCriteria: string[] } {
  return {
    title: typeof raw?.title === 'string' ? raw.title : '',
    definitionOfDone: typeof raw?.definitionOfDone === 'string' ? raw.definitionOfDone : '',
    acceptanceCriteria: Array.isArray(raw?.acceptanceCriteria) ? raw.acceptanceCriteria : []
  };
}

export async function taskCreationNode(state: DevTeamState): Promise<Partial<DevTeamState>> {
  if (!state.plan) {
    throw new Error('taskCreationNode requiere state.plan — debe ejecutarse después de judgeNode.');
  }

  const rawTask = await generateStructuredJSON({
    systemInstruction: buildSystemInstruction(Boolean(state.jiraIssueKey)),
    userPrompt: buildUserPrompt(
      state.spec ? formatSpecSummary(state.spec) : '(sin spec)',
      formatPlanSummary(state.plan)
    ),
    geminiSchema: TASK_GEMINI_SCHEMA,
    openaiSchema: TASK_OPENAI_SCHEMA
  }, { primaryProvider: 'openai' });

  const task = normalizeTaskDefinition(rawTask);

  let id: string;
  if (state.jiraIssueKey) {
    await updateJiraIssue(state.jiraIssueKey, buildTaskDescriptionAdf(task.definitionOfDone, task.acceptanceCriteria));
    id = state.jiraIssueKey;
  } else {
    const created = await createJiraIssue(task);
    id = created.key;
  }

  return {
    tasks: [
      {
        id,
        title: task.title,
        definitionOfDone: task.definitionOfDone,
        acceptanceCriteria: task.acceptanceCriteria,
        assignee: 'dev',
        status: 'todo'
      }
    ]
  };
}
