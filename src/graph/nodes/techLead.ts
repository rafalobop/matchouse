// graph/nodes/techLead.ts — Tech Lead (rol de debate paralelo)
// Input: state.spec | Output: state.roleInputs.techLead

import * as fs from 'fs';
import * as path from 'path';
import { DevTeamState } from '../state';
import { runProposerOpposerReconcile, formatSpecSummary } from '../debate';

const TECH_LEAD_SKILL_PATH = path.join(
  __dirname,
  '../../../.agent/skills/tech_lead/SKILL.md'
);

function loadTechLeadSkill(): string {
  return fs.readFileSync(TECH_LEAD_SKILL_PATH, 'utf-8');
}

const TECH_LEAD_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    approach: { type: 'STRING', description: 'Approach técnico concreto: qué archivos/módulos se tocan, qué patrón se usa, qué se reutiliza vs qué es nuevo' },
    tradeoffs: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Tradeoffs principales de diseño de esa solución' },
    risks: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Riesgos técnicos reales: edge cases, riesgo de romper funcionalidad existente' },
    selfCritique: { type: 'STRING', description: 'Punto más fuerte que encontró el Opposer, aunque no haya cambiado la conclusión final' }
  },
  required: ['approach', 'tradeoffs', 'risks', 'selfCritique']
};

const TECH_LEAD_OPENAI_SCHEMA = {
  name: 'tech_lead_role_input',
  schema: {
    type: 'object',
    properties: {
      approach: { type: 'string' },
      tradeoffs: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      selfCritique: { type: 'string' }
    },
    required: ['approach', 'tradeoffs', 'risks', 'selfCritique'],
    additionalProperties: false
  }
};

export function normalizeTechLeadInput(raw: any): NonNullable<DevTeamState['roleInputs']['techLead']> {
  return {
    approach: typeof raw?.approach === 'string' ? raw.approach : '',
    tradeoffs: Array.isArray(raw?.tradeoffs) ? raw.tradeoffs : [],
    risks: Array.isArray(raw?.risks) ? raw.risks : [],
    selfCritique: typeof raw?.selfCritique === 'string' ? raw.selfCritique : ''
  };
}

export async function techLeadNode(state: DevTeamState): Promise<{ roleInputs: Partial<DevTeamState['roleInputs']> }> {
  if (!state.spec) {
    throw new Error('techLeadNode requiere state.spec — debe ejecutarse después de poNode.');
  }

  const techLeadInput = await runProposerOpposerReconcile({
    context: {
      roleName: 'Tech Lead',
      roleHandle: '@techlead',
      skillContent: loadTechLeadSkill(),
      specSummary: formatSpecSummary(state.spec)
    },
    reconcileSchemas: {
      geminiSchema: TECH_LEAD_GEMINI_SCHEMA,
      openaiSchema: TECH_LEAD_OPENAI_SCHEMA
    },
    normalizeReconcile: normalizeTechLeadInput
  });

  return { roleInputs: { techLead: techLeadInput } };
}
