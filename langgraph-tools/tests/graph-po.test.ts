import test from 'node:test';
import assert from 'node:assert';
import { poNode, normalizeSpec, resolveSource } from '../src/graph/nodes/po';
import * as jira from '../src/graph/jira';

function baseState(overrides: Partial<Parameters<typeof poNode>[0]> = {}): Parameters<typeof poNode>[0] {
  return {
    jiraIssueKey: null,
    rawIdea: '',
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

test('graph/nodes/po - resolveSource prioriza jiraIssueKey y arma el texto a partir de la issue', async (t) => {
  t.mock.method(jira, 'fetchJiraIssue', async (issueKey: string) => {
    assert.strictEqual(issueKey, 'HOUSE-42');
    return { key: 'HOUSE-42', issueType: 'Story', summary: 'Como usuario quiero X', descriptionText: 'Detalle de la historia' };
  });

  const result = await resolveSource(baseState({ jiraIssueKey: 'HOUSE-42', rawIdea: 'esto no debería usarse' }));

  assert.strictEqual(result.issueType, 'Story');
  assert.match(result.text, /Como usuario quiero X/);
  assert.match(result.text, /Detalle de la historia/);
});

test('graph/nodes/po - resolveSource cae a rawIdea manual cuando no hay jiraIssueKey', async () => {
  const result = await resolveSource(baseState({ rawIdea: 'Idea tipeada a mano' }));

  assert.strictEqual(result.issueType, null);
  assert.strictEqual(result.text, 'Idea tipeada a mano');
});

test('graph/nodes/po - resolveSource tira error claro si no hay jiraIssueKey ni rawIdea', async () => {
  await assert.rejects(
    () => resolveSource(baseState()),
    /requiere state\.jiraIssueKey o state\.rawIdea/
  );
});
