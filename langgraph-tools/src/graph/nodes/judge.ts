// graph/nodes/judge.ts — Judge (fan-in de pm/em/techLead)
// Input: state.spec + state.roleInputs (completo) | Output: state.plan + state.conflictsResolved

import * as fs from 'fs';
import * as path from 'path';
import { DevTeamState } from '../state';
import { generateStructuredJSON } from '../llm';
import { formatSpecSummary } from '../debate';

const JUDGE_SKILL_PATH = path.join(
  __dirname,
  '../../../../.agent/skills/judge/SKILL.md'
);

function loadJudgeSkill(): string {
  return fs.readFileSync(JUDGE_SKILL_PATH, 'utf-8');
}

function formatRoleInputsSummary(roleInputs: DevTeamState['roleInputs']): string {
  const pm = roleInputs.pm!;
  const em = roleInputs.em!;
  const techLead = roleInputs.techLead!;

  return `--- PM (@pm) ---
Concerns: ${pm.concerns.length > 0 ? pm.concerns.join(' | ') : '(ninguno)'}
Priorities: ${pm.priorities.length > 0 ? pm.priorities.join(' | ') : '(ninguna)'}
Self-critique: ${pm.selfCritique}

--- EM (@em) ---
Feasibility: ${em.feasibility}
Risks: ${em.risks.length > 0 ? em.risks.join(' | ') : '(ninguno)'}
Resourcing: ${em.resourcing}
Self-critique: ${em.selfCritique}

--- Tech Lead (@techlead) ---
Approach: ${techLead.approach}
Tradeoffs: ${techLead.tradeoffs.length > 0 ? techLead.tradeoffs.join(' | ') : '(ninguno)'}
Risks: ${techLead.risks.length > 0 ? techLead.risks.join(' | ') : '(ninguno)'}
Self-critique: ${techLead.selfCritique}`;
}

function buildSystemInstruction(): string {
  const skill = loadJudgeSkill();

  return `Encarnás el rol "Judge" dentro de un grafo LangGraph que simula un equipo de desarrollo de software para el proyecto Brokaza. Sos el punto de fan-in de un debate paralelo: PM, EM y Tech Lead ya dieron su postura final, sin verse entre sí.

Tu comportamiento y criterio están definidos por la siguiente skill (persona @judge). Seguila al pie de la letra:

<JUDGE_SKILL>
${skill}
</JUDGE_SKILL>

No es una conversación con el usuario humano — no repreguntes, trabajá con la información que tenés. Si un conflicto entre roles no se puede resolver sin más información, dejalo explícito en "conflictsResolved" en vez de inventar una resolución artificial.

Reglas de salida:
- Respondé ÚNICAMENTE con el JSON estructurado pedido, sin texto adicional.
- "conflictsResolved" puede ser un array vacío si las 3 posturas ya eran compatibles entre sí — no inventes conflictos que no existen.
- "plan.approach" tiene que ser una decisión concreta y ejecutable, no una lista de opciones sin resolver.
- "plan.approvedBy" solo debe incluir los handles de rol que efectivamente quedan alineados con la decisión final (de "pm", "em", "techLead").`;
}

function buildUserPrompt(specSummary: string, roleInputsSummary: string): string {
  return `Especificación funcional, dentro de <SPEC>:
<SPEC>
${specSummary}
</SPEC>

Las 3 posturas finales del debate (ya reconciliadas internamente por cada rol), dentro de <ROLE_INPUTS>:
<ROLE_INPUTS>
${roleInputsSummary}
</ROLE_INPUTS>

Arbitrá entre las 3 y producí tu decisión final.`;
}

const JUDGE_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    plan: {
      type: 'OBJECT',
      properties: {
        approach: { type: 'STRING', description: 'Decisión final concreta y ejecutable' },
        risks: { type: 'ARRAY', items: { type: 'STRING' } },
        tradeoffs: { type: 'ARRAY', items: { type: 'STRING' } },
        approvedBy: { type: 'ARRAY', items: { type: 'STRING', enum: ['pm', 'em', 'techLead'] } }
      },
      required: ['approach', 'risks', 'tradeoffs', 'approvedBy']
    },
    conflictsResolved: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          issue: { type: 'STRING', description: 'La contradicción concreta entre roles' },
          resolution: { type: 'STRING', description: 'Cómo la resolvió el Judge' }
        },
        required: ['issue', 'resolution']
      }
    }
  },
  required: ['plan', 'conflictsResolved']
};

const JUDGE_OPENAI_SCHEMA = {
  name: 'judge_output',
  schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        properties: {
          approach: { type: 'string' },
          risks: { type: 'array', items: { type: 'string' } },
          tradeoffs: { type: 'array', items: { type: 'string' } },
          approvedBy: { type: 'array', items: { type: 'string', enum: ['pm', 'em', 'techLead'] } }
        },
        required: ['approach', 'risks', 'tradeoffs', 'approvedBy'],
        additionalProperties: false
      },
      conflictsResolved: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            issue: { type: 'string' },
            resolution: { type: 'string' }
          },
          required: ['issue', 'resolution'],
          additionalProperties: false
        }
      }
    },
    required: ['plan', 'conflictsResolved'],
    additionalProperties: false
  }
};

const VALID_APPROVERS = ['pm', 'em', 'techLead'];

export function normalizeJudgeOutput(raw: any): { plan: NonNullable<DevTeamState['plan']>; conflictsResolved: DevTeamState['conflictsResolved'] } {
  const rawApprovedBy = Array.isArray(raw?.plan?.approvedBy) ? raw.plan.approvedBy : [];

  const plan: NonNullable<DevTeamState['plan']> = {
    approach: typeof raw?.plan?.approach === 'string' ? raw.plan.approach : '',
    risks: Array.isArray(raw?.plan?.risks) ? raw.plan.risks : [],
    tradeoffs: Array.isArray(raw?.plan?.tradeoffs) ? raw.plan.tradeoffs : [],
    approvedBy: rawApprovedBy.filter((role: any) => VALID_APPROVERS.includes(role))
  };

  const conflictsResolved: DevTeamState['conflictsResolved'] = Array.isArray(raw?.conflictsResolved)
    ? raw.conflictsResolved
      .filter((c: any) => typeof c?.issue === 'string' && typeof c?.resolution === 'string')
      .map((c: any) => ({ issue: c.issue, resolution: c.resolution }))
    : [];

  return { plan, conflictsResolved };
}

export async function judgeNode(state: DevTeamState): Promise<Partial<DevTeamState>> {
  if (!state.spec) {
    throw new Error('judgeNode requiere state.spec — debe ejecutarse después de poNode.');
  }
  if (!state.roleInputs.pm || !state.roleInputs.em || !state.roleInputs.techLead) {
    throw new Error('judgeNode requiere que pm/em/techLead ya hayan corrido (fan-in) — algún roleInput vino null.');
  }

  const rawOutput = await generateStructuredJSON({
    systemInstruction: buildSystemInstruction(),
    userPrompt: buildUserPrompt(formatSpecSummary(state.spec), formatRoleInputsSummary(state.roleInputs)),
    geminiSchema: JUDGE_GEMINI_SCHEMA,
    openaiSchema: JUDGE_OPENAI_SCHEMA
  }, { primaryProvider: 'openai' });

  return normalizeJudgeOutput(rawOutput);
}
