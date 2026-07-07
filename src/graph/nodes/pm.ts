// graph/nodes/pm.ts — Project Manager (rol de debate paralelo)
// Input: state.spec | Output: state.roleInputs.pm

import * as fs from 'fs';
import * as path from 'path';
import { DevTeamState } from '../state';
import { runProposerOpposerReconcile, formatSpecSummary } from '../debate';

// Igual que po.ts: se lee en cada carga del módulo, no se embebe como string,
// para que el comportamiento evolucione junto con .agent/skills/project_manager/SKILL.md.
const PROJECT_MANAGER_SKILL_PATH = path.join(
  __dirname,
  '../../../.agent/skills/project_manager/SKILL.md'
);

function loadProjectManagerSkill(): string {
  return fs.readFileSync(PROJECT_MANAGER_SKILL_PATH, 'utf-8');
}

const PM_GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    concerns: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Riesgos de alcance (scope creep), dependencias bloqueantes externas, features que no agregan valor directo/inmediato'
    },
    priorities: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Desglose de fases (ej. MVP vs. posteriores) y orden de ejecución para maximizar valor de entrega rápido'
    },
    selfCritique: { type: 'STRING', description: 'Punto más fuerte que encontró el Opposer, aunque no haya cambiado la conclusión final' }
  },
  required: ['concerns', 'priorities', 'selfCritique']
};

const PM_OPENAI_SCHEMA = {
  name: 'pm_role_input',
  schema: {
    type: 'object',
    properties: {
      concerns: { type: 'array', items: { type: 'string' } },
      priorities: { type: 'array', items: { type: 'string' } },
      selfCritique: { type: 'string' }
    },
    required: ['concerns', 'priorities', 'selfCritique'],
    additionalProperties: false
  }
};

export function normalizePMInput(raw: any): NonNullable<DevTeamState['roleInputs']['pm']> {
  return {
    concerns: Array.isArray(raw?.concerns) ? raw.concerns : [],
    priorities: Array.isArray(raw?.priorities) ? raw.priorities : [],
    selfCritique: typeof raw?.selfCritique === 'string' ? raw.selfCritique : ''
  };
}

export async function pmNode(state: DevTeamState): Promise<{ roleInputs: Partial<DevTeamState['roleInputs']> }> {
  if (!state.spec) {
    throw new Error('pmNode requiere state.spec — debe ejecutarse después de poNode.');
  }

  const pmInput = await runProposerOpposerReconcile({
    context: {
      roleName: 'Project Manager (PM)',
      roleHandle: '@pm',
      skillContent: loadProjectManagerSkill(),
      specSummary: formatSpecSummary(state.spec)
    },
    reconcileSchemas: {
      geminiSchema: PM_GEMINI_SCHEMA,
      openaiSchema: PM_OPENAI_SCHEMA
    },
    normalizeReconcile: normalizePMInput
  });

  return { roleInputs: { pm: pmInput } };
}
