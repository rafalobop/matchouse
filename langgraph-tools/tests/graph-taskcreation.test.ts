import test from 'node:test';
import assert from 'node:assert';
import * as llm from '../src/graph/llm';
import * as jira from '../src/graph/jira';
import { taskCreationNode, normalizeTaskDefinition } from '../src/graph/nodes/taskCreation';
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

const FILLED_PLAN: NonNullable<DevTeamState['plan']> = {
  approach: 'Refactorizar X',
  risks: ['riesgo 1'],
  tradeoffs: ['tradeoff 1'],
  approvedBy: ['pm', 'em', 'techLead']
};

function mockTaskDefinition(t: any, overrides: Partial<{ title: string; definitionOfDone: string; acceptanceCriteria: string[] }> = {}) {
  t.mock.method(llm, 'generateStructuredJSON', async () => ({
    title: 'Título mockeado',
    definitionOfDone: 'DoD mockeado',
    acceptanceCriteria: ['criterio mockeado'],
    ...overrides
  }));
}

test('graph/nodes/taskCreation - taskCreationNode debería ser una función', () => {
  assert.strictEqual(typeof taskCreationNode, 'function');
});

test('graph/nodes/taskCreation - normalizeTaskDefinition completa defaults ante un JSON incompleto del LLM', () => {
  const task = normalizeTaskDefinition({ title: 'Solo título' });

  assert.strictEqual(task.title, 'Solo título');
  assert.strictEqual(task.definitionOfDone, '');
  assert.deepStrictEqual(task.acceptanceCriteria, []);
});

test('graph/nodes/taskCreation - taskCreationNode rechaza correr sin state.plan', async () => {
  await assert.rejects(
    () => taskCreationNode(baseState()),
    /requiere state\.plan/
  );
});

test('graph/nodes/taskCreation - con jiraIssueKey presente, actualiza el ticket existente (no crea uno nuevo)', async (t) => {
  mockTaskDefinition(t);

  let updateCalled = false;
  let createCalled = false;

  t.mock.method(jira, 'updateJiraIssue', async (issueKey: string) => {
    updateCalled = true;
    assert.strictEqual(issueKey, 'KAN-12');
  });
  t.mock.method(jira, 'createJiraIssue', async () => {
    createCalled = true;
    return { key: 'NO-DEBERIA-LLAMARSE' };
  });

  const result = await taskCreationNode(baseState({ jiraIssueKey: 'KAN-12', plan: FILLED_PLAN }));

  assert.ok(updateCalled, 'debe llamar a updateJiraIssue cuando hay jiraIssueKey.');
  assert.ok(!createCalled, 'NO debe llamar a createJiraIssue cuando hay jiraIssueKey.');
  assert.strictEqual(result.tasks?.length, 1);
  assert.strictEqual(result.tasks?.[0].id, 'KAN-12', 'el id de la tarea debe ser la key original del ticket.');
  assert.strictEqual(result.tasks?.[0].assignee, 'dev');
  assert.strictEqual(result.tasks?.[0].status, 'todo');
});

test('graph/nodes/taskCreation - sin jiraIssueKey, crea un ticket nuevo (no actualiza ninguno)', async (t) => {
  mockTaskDefinition(t);

  let updateCalled = false;
  let createCalled = false;

  t.mock.method(jira, 'updateJiraIssue', async () => {
    updateCalled = true;
  });
  t.mock.method(jira, 'createJiraIssue', async () => {
    createCalled = true;
    return { key: 'HOUSE-99' };
  });

  const result = await taskCreationNode(baseState({ jiraIssueKey: null, plan: FILLED_PLAN }));

  assert.ok(createCalled, 'debe llamar a createJiraIssue cuando no hay jiraIssueKey.');
  assert.ok(!updateCalled, 'NO debe llamar a updateJiraIssue cuando no hay jiraIssueKey.');
  assert.strictEqual(result.tasks?.length, 1);
  assert.strictEqual(result.tasks?.[0].id, 'HOUSE-99', 'el id de la tarea debe ser la key devuelta por Jira al crear.');
});
