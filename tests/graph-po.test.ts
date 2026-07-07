import test from 'node:test';
import assert from 'node:assert';
import { poNode, normalizeSpec } from '../src/graph/nodes/po';

// Sigue el patrón de tests/ai.test.ts: sin llamadas reales a Gemini/OpenAI en
// la suite, se testea la forma/normalización del nodo con fixtures a mano
// (Paso 5 de la skill langgraph-dev-team-scaffolder: nodo aislado, sin correr el grafo).

test('graph/nodes/po - poNode debería ser una función', () => {
  assert.strictEqual(typeof poNode, 'function', 'poNode debe ser una función.');
});

test('graph/nodes/po - normalizeSpec debería completar defaults ante un JSON incompleto del LLM', () => {
  const spec = normalizeSpec({ title: 'Feature X' });

  assert.strictEqual(spec.title, 'Feature X');
  assert.strictEqual(spec.problem, '');
  assert.strictEqual(spec.proposedSolution, '');
  assert.deepStrictEqual(spec.openQuestions, []);
  assert.strictEqual(spec.status, 'draft', 'Sin status válido del LLM, debe caer a "draft" por defecto.');
});

test('graph/nodes/po - normalizeSpec nunca deja pasar status "approved" (esa transición no la decide el PO)', () => {
  const spec = normalizeSpec({
    title: 'Feature Y',
    problem: 'Problema',
    proposedSolution: 'Solución',
    openQuestions: [],
    status: 'approved'
  });

  assert.strictEqual(spec.status, 'draft');
});

test('graph/nodes/po - normalizeSpec respeta status "reviewed" cuando el LLM lo devuelve explícitamente', () => {
  const spec = normalizeSpec({
    title: 'Feature Z',
    problem: 'Problema',
    proposedSolution: 'Solución',
    openQuestions: [],
    status: 'reviewed'
  });

  assert.strictEqual(spec.status, 'reviewed');
});

test('graph/nodes/po - normalizeSpec fuerza openQuestions a array aunque el LLM devuelva otra cosa', () => {
  const spec = normalizeSpec({ openQuestions: 'no es un array' });
  assert.deepStrictEqual(spec.openQuestions, []);
});
