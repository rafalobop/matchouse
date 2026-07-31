import test from 'node:test';
import assert from 'node:assert';
import { judgeNode, normalizeJudgeOutput } from '../src/graph/nodes/judge';
import { DevTeamState } from '../src/graph/state';

function baseState(overrides: Partial<DevTeamState> = {}): DevTeamState {
  return {
    jiraIssueKey: null,
    rawIdea: 'idea',
    spec: null,
    roleInputs: { pm: null, em: null, techLead: null },
    conflictsResolved: [],
    plan: null,
    tasks: [],
    qaResult: null,
    correctionFocus: null,
    retryCount: 0,
    maxRetries: 3,
    ...overrides
  };
}

const FILLED_SPEC: NonNullable<DevTeamState['spec']> = {
  title: 'Feature X',
  problem: 'Problema',
  proposedSolution: 'Solución',
  openQuestions: [],
  status: 'reviewed'
};

const FILLED_ROLE_INPUTS: DevTeamState['roleInputs'] = {
  pm: { concerns: [], priorities: [], selfCritique: '' },
  em: { feasibility: '', risks: [], resourcing: '', selfCritique: '' },
  techLead: { approach: '', tradeoffs: [], risks: [], selfCritique: '' }
};

test('graph/nodes/judge - judgeNode debería ser una función', () => {
  assert.strictEqual(typeof judgeNode, 'function', 'judgeNode debe ser una función.');
});

test('graph/nodes/judge - normalizeJudgeOutput completa defaults ante un JSON incompleto del LLM', () => {
  const output = normalizeJudgeOutput({ plan: { approach: 'Hacer X' } });

  assert.strictEqual(output.plan.approach, 'Hacer X');
  assert.deepStrictEqual(output.plan.risks, []);
  assert.deepStrictEqual(output.plan.tradeoffs, []);
  assert.deepStrictEqual(output.plan.approvedBy, []);
  assert.deepStrictEqual(output.conflictsResolved, []);
});

test('graph/nodes/judge - normalizeJudgeOutput filtra approvedBy a solo roles válidos (pm/em/techLead)', () => {
  const output = normalizeJudgeOutput({
    plan: { approach: 'x', risks: [], tradeoffs: [], approvedBy: ['pm', 'qa', 'techLead', 'inventado'] }
  });

  assert.deepStrictEqual(output.plan.approvedBy, ['pm', 'techLead']);
});

test('graph/nodes/judge - normalizeJudgeOutput filtra items malformados de conflictsResolved', () => {
  const output = normalizeJudgeOutput({
    plan: { approach: 'x' },
    conflictsResolved: [
      { issue: 'PM quiere alcance completo, EM dice que no es viable', resolution: 'Se recorta a MVP' },
      { issue: 'sin resolution' },
      'no es un objeto'
    ]
  });

  assert.deepStrictEqual(output.conflictsResolved, [
    { issue: 'PM quiere alcance completo, EM dice que no es viable', resolution: 'Se recorta a MVP' }
  ]);
});

test('graph/nodes/judge - judgeNode rechaza correr sin state.spec', async () => {
  await assert.rejects(
    () => judgeNode(baseState({ roleInputs: FILLED_ROLE_INPUTS })),
    /requiere state\.spec/
  );
});

test('graph/nodes/judge - judgeNode rechaza correr si algún roleInput todavía es null (fan-in incompleto)', async () => {
  await assert.rejects(
    () => judgeNode(baseState({ spec: FILLED_SPEC, roleInputs: { pm: FILLED_ROLE_INPUTS.pm, em: null, techLead: FILLED_ROLE_INPUTS.techLead } })),
    /pm\/em\/techLead ya hayan corrido/
  );
});
