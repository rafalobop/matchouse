// graph/nodes/em.ts — Engineering Manager (rol de debate paralelo)
// Input: state.spec | Output: state.roleInputs.em

import * as fs from 'fs';
import * as path from 'path';
import { DevTeamState } from '../state';
import { runProposerOpposerReconcile, formatSpecSummary } from '../debate';

const ENGINEERING_MANAGER_SKILL_PATH = path.join(
  __dirname,
  '../../../.agent/skills/engineering_manager/SKILL.md'
);

function loadEngineeringManagerSkill(): string {
  return fs.readFileSync(ENGINEERING_MANAGER_SKILL_PATH, 'utf-8');
}

const EM_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    feasibility: { type: 'STRING', description: 'Evaluación concreta de viabilidad: tiempo, complejidad, dependencias externas' },
    risks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Riesgos operativos concretos — qué podría salir mal en producción, en el equipo, o en el timeline'
    },
    resourcing: { type: 'STRING', description: 'Qué roles/tiempo hacen falta para ejecutar la propuesta' },
    selfCritique: { type: 'STRING', description: 'Punto más fuerte que encontró el Opposer, aunque no haya cambiado la conclusión final' }
  },
  required: ['feasibility', 'risks', 'resourcing', 'selfCritique']
};

const EM_OPENAI_SCHEMA = {
  name: 'em_role_input',
  schema: {
    type: 'object',
    properties: {
      feasibility: { type: 'string' },
      risks: { type: 'array', items: { type: 'string' } },
      resourcing: { type: 'string' },
      selfCritique: { type: 'string' }
    },
    required: ['feasibility', 'risks', 'resourcing', 'selfCritique'],
    additionalProperties: false
  }
};

export function normalizeEMInput(raw: any): NonNullable<DevTeamState['roleInputs']['em']> {
  return {
    feasibility: typeof raw?.feasibility === 'string' ? raw.feasibility : '',
    risks: Array.isArray(raw?.risks) ? raw.risks : [],
    resourcing: typeof raw?.resourcing === 'string' ? raw.resourcing : '',
    selfCritique: typeof raw?.selfCritique === 'string' ? raw.selfCritique : ''
  };
}

export async function emNode(state: DevTeamState): Promise<{ roleInputs: Partial<DevTeamState['roleInputs']> }> {
  if (!state.spec) {
    throw new Error('emNode requiere state.spec — debe ejecutarse después de poNode.');
  }

  const emInput = await runProposerOpposerReconcile({
    context: {
      roleName: 'Engineering Manager (EM)',
      roleHandle: '@em',
      skillContent: loadEngineeringManagerSkill(),
      specSummary: formatSpecSummary(state.spec)
    },
    reconcileSchemas: {
      geminiSchema: EM_GEMINI_SCHEMA,
      openaiSchema: EM_OPENAI_SCHEMA
    },
    normalizeReconcile: normalizeEMInput
  });

  return { roleInputs: { em: emInput } };
}
