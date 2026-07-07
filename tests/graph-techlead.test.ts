import test from 'node:test';
import assert from 'node:assert';
import { techLeadNode, normalizeTechLeadInput } from '../src/graph/nodes/techLead';

test('graph/nodes/techLead - techLeadNode debería ser una función', () => {
  assert.strictEqual(typeof techLeadNode, 'function', 'techLeadNode debe ser una función.');
});

test('graph/nodes/techLead - normalizeTechLeadInput debería completar defaults ante un JSON incompleto del LLM', () => {
  const input = normalizeTechLeadInput({ approach: 'Reusar matcher.ts con nueva estrategia' });

  assert.strictEqual(input.approach, 'Reusar matcher.ts con nueva estrategia');
  assert.deepStrictEqual(input.tradeoffs, []);
  assert.deepStrictEqual(input.risks, []);
  assert.strictEqual(input.selfCritique, '');
});

test('graph/nodes/techLead - normalizeTechLeadInput fuerza tradeoffs/risks a array aunque el LLM devuelva otra cosa', () => {
  const input = normalizeTechLeadInput({ tradeoffs: 'no es un array', risks: 123 });
  assert.deepStrictEqual(input.tradeoffs, []);
  assert.deepStrictEqual(input.risks, []);
});

test('graph/nodes/techLead - techLeadNode rechaza correr sin state.spec (invariante de orden en el grafo)', async () => {
  await assert.rejects(
    () => techLeadNode({
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
