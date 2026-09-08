import test from 'node:test';
import assert from 'node:assert';
import { emNode, normalizeEMInput } from '../src/graph/nodes/em';

test('graph/nodes/em - emNode debería ser una función', () => {
  assert.strictEqual(typeof emNode, 'function', 'emNode debe ser una función.');
});

test('graph/nodes/em - normalizeEMInput debería completar defaults ante un JSON incompleto del LLM', () => {
  const input = normalizeEMInput({ feasibility: 'Viable en 2 sprints' });

  assert.strictEqual(input.feasibility, 'Viable en 2 sprints');
  assert.deepStrictEqual(input.risks, []);
  assert.strictEqual(input.resourcing, '');
  assert.strictEqual(input.selfCritique, '');
});

test('graph/nodes/em - normalizeEMInput fuerza risks a array aunque el LLM devuelva otra cosa', () => {
  const input = normalizeEMInput({ risks: 'no es un array' });
  assert.deepStrictEqual(input.risks, []);
});

test('graph/nodes/em - emNode rechaza correr sin state.spec (invariante de orden en el grafo)', async () => {
  await assert.rejects(
    () => emNode({
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
      maxRetries: 3
    }),
    /requiere state\.spec/
  );
});
