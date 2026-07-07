import test from 'node:test';
import assert from 'node:assert';
import { pmNode, normalizePMInput } from '../src/graph/nodes/pm';

test('graph/nodes/pm - pmNode debería ser una función', () => {
  assert.strictEqual(typeof pmNode, 'function', 'pmNode debe ser una función.');
});

test('graph/nodes/pm - normalizePMInput debería completar defaults ante un JSON incompleto del LLM', () => {
  const input = normalizePMInput({ priorities: ['MVP primero'] });

  assert.deepStrictEqual(input.concerns, []);
  assert.deepStrictEqual(input.priorities, ['MVP primero']);
  assert.strictEqual(input.selfCritique, '');
});

test('graph/nodes/pm - normalizePMInput fuerza concerns/priorities a array aunque el LLM devuelva otra cosa', () => {
  const input = normalizePMInput({ concerns: 'no es un array', priorities: null, selfCritique: 42 });

  assert.deepStrictEqual(input.concerns, []);
  assert.deepStrictEqual(input.priorities, []);
  assert.strictEqual(input.selfCritique, '');
});

test('graph/nodes/pm - pmNode rechaza correr sin state.spec (invariante de orden en el grafo)', async () => {
  await assert.rejects(
    () => pmNode({
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
