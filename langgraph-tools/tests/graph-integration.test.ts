import test from 'node:test';
import assert from 'node:assert';
import * as llm from '../src/graph/llm';
import * as jira from '../src/graph/jira';
import { buildDevTeamGraph } from '../src/graph/graph';

// Test de integración del GRAFO (no de un nodo aislado): corre po -> [pm, em, techLead]
// -> judge de punta a punta a través del StateGraph compilado, mockeando la capa
// de LLM (src/graph/llm.ts) para no pegarle a Gemini/OpenAI reales en la suite.
//
// Lo que valida específicamente:
// 1. El fan-out real está cableado: po dispara a los 3 roles.
// 2. El fix del reducer de roleInputs (merge superficial, ver src/graph/graph.ts)
//    funciona: las 3 escrituras paralelas del mismo superstep NO se pisan entre sí.
//    Antes del fix, con un reducer "overwrite" a nivel de todo el objeto roleInputs,
//    solo el último nodo en aplicarse hubiera sobrevivido.
// 3. El camino de entrada por Jira (jiraIssueKey) también corre de punta a punta,
//    mockeando src/graph/jira.ts además de llm.ts.
// 4. El fan-in real hacia judge (addEdge con array de origen) dispara judgeNode
//    UNA sola vez, con las 3 ramas ya completas — no una vez por rama.

function mockStructuredResponses(t: any): { schemaCallCounts: Record<string, number> } {
  const schemaCallCounts: Record<string, number> = {};

  t.mock.method(llm, 'generateText', async () => 'texto de debate mockeado');

  t.mock.method(llm, 'generateStructuredJSON', async (params: any) => {
    const schemaName = params.openaiSchema.name;
    schemaCallCounts[schemaName] = (schemaCallCounts[schemaName] ?? 0) + 1;

    switch (schemaName) {
      case 'product_owner_spec':
        return {
          title: 'Spec mockeada',
          problem: 'Problema mockeado',
          proposedSolution: 'Solución mockeada',
          openQuestions: [],
          status: 'reviewed'
        };
      case 'pm_role_input':
        return { concerns: ['concern mockeado'], priorities: ['prioridad mockeada'], selfCritique: 'autocrítica pm' };
      case 'em_role_input':
        return { feasibility: 'feasibility mockeada', risks: ['riesgo em'], resourcing: 'resourcing mockeado', selfCritique: 'autocrítica em' };
      case 'tech_lead_role_input':
        return { approach: 'approach mockeado', tradeoffs: ['tradeoff mockeado'], risks: ['riesgo tech'], selfCritique: 'autocrítica techlead' };
      case 'judge_output':
        return {
          plan: { approach: 'approach final mockeado', risks: ['riesgo final'], tradeoffs: ['tradeoff final'], approvedBy: ['pm', 'em', 'techLead'] },
          conflictsResolved: [{ issue: 'conflicto mockeado', resolution: 'resolución mockeada' }]
        };
      case 'task_definition':
        return { title: 'Título de tarea mockeado', definitionOfDone: 'DoD mockeado', acceptanceCriteria: ['criterio mockeado'] };
      default:
        throw new Error(`Schema no mockeado en el test: ${schemaName}`);
    }
  });

  return { schemaCallCounts };
}

function assertFanOutSurvived(result: any) {
  assert.ok(result.roleInputs.pm, 'roleInputs.pm no debe perderse por el fan-out paralelo.');
  assert.ok(result.roleInputs.em, 'roleInputs.em no debe perderse por el fan-out paralelo.');
  assert.ok(result.roleInputs.techLead, 'roleInputs.techLead no debe perderse por el fan-out paralelo.');

  assert.strictEqual(result.roleInputs.pm.selfCritique, 'autocrítica pm');
  assert.strictEqual(result.roleInputs.em.selfCritique, 'autocrítica em');
  assert.strictEqual(result.roleInputs.techLead.selfCritique, 'autocrítica techlead');
}

function assertJudgeRanOnce(result: any, schemaCallCounts: Record<string, number>) {
  assert.strictEqual(schemaCallCounts['judge_output'], 1, 'judgeNode debe correr exactamente una vez, con las 3 ramas del fan-out ya completas (no una vez por rama).');

  assert.deepStrictEqual(result.plan, {
    approach: 'approach final mockeado',
    risks: ['riesgo final'],
    tradeoffs: ['tradeoff final'],
    approvedBy: ['pm', 'em', 'techLead']
  });
  assert.deepStrictEqual(result.conflictsResolved, [{ issue: 'conflicto mockeado', resolution: 'resolución mockeada' }]);
}

test('graph/graph - buildDevTeamGraph compila sin errores y expone un grafo invocable', () => {
  const graph = buildDevTeamGraph();
  assert.strictEqual(typeof graph.invoke, 'function', 'El grafo compilado debe exponer .invoke().');
});

test('graph/graph - po -> [pm, em, techLead] -> judge -> taskCreation corre de punta a punta con rawIdea manual (crea un ticket nuevo)', async (t) => {
  const { schemaCallCounts } = mockStructuredResponses(t);

  let createCalled = false;
  t.mock.method(jira, 'createJiraIssue', async () => {
    createCalled = true;
    return { key: 'HOUSE-99' };
  });
  t.mock.method(jira, 'updateJiraIssue', async () => {
    throw new Error('No debería llamarse updateJiraIssue sin jiraIssueKey de origen.');
  });

  const graph = buildDevTeamGraph();
  const result = await graph.invoke({ rawIdea: 'Idea de prueba para el grafo' });

  assert.deepStrictEqual(result.spec, {
    title: 'Spec mockeada',
    problem: 'Problema mockeado',
    proposedSolution: 'Solución mockeada',
    openQuestions: [],
    status: 'reviewed'
  }, 'poNode debe haber corrido y poblado state.spec.');

  assertFanOutSurvived(result);
  assertJudgeRanOnce(result, schemaCallCounts);

  assert.ok(createCalled, 'sin jiraIssueKey de origen, taskCreation debe crear un ticket nuevo.');
  assert.strictEqual(result.tasks.length, 1);
  assert.strictEqual(result.tasks[0].id, 'HOUSE-99');
});

test('graph/graph - po -> [pm, em, techLead] -> judge -> taskCreation corre de punta a punta cuando la entrada es una jiraIssueKey (refina el ticket existente)', async (t) => {
  const { schemaCallCounts } = mockStructuredResponses(t);

  t.mock.method(jira, 'fetchJiraIssue', async (issueKey: string) => {
    assert.strictEqual(issueKey, 'HOUSE-42');
    return { key: 'HOUSE-42', issueType: 'Story', summary: 'Historia mockeada', descriptionText: 'Descripción mockeada' };
  });

  let updateCalled = false;
  t.mock.method(jira, 'updateJiraIssue', async (issueKey: string) => {
    updateCalled = true;
    assert.strictEqual(issueKey, 'HOUSE-42');
  });
  t.mock.method(jira, 'createJiraIssue', async () => {
    throw new Error('No debería llamarse createJiraIssue cuando hay jiraIssueKey de origen.');
  });

  const graph = buildDevTeamGraph();
  const result = await graph.invoke({ jiraIssueKey: 'HOUSE-42' });

  assert.match(result.rawIdea, /Historia mockeada/, 'poNode debe volcar el contenido de la issue en rawIdea (trazabilidad).');
  assert.ok(result.spec, 'poNode debe haber corrido y poblado state.spec.');
  assert.strictEqual(result.spec.title, 'Spec mockeada');

  assertFanOutSurvived(result);
  assertJudgeRanOnce(result, schemaCallCounts);

  assert.ok(updateCalled, 'con jiraIssueKey de origen, taskCreation debe refinar/actualizar ese mismo ticket.');
  assert.strictEqual(result.tasks.length, 1);
  assert.strictEqual(result.tasks[0].id, 'HOUSE-42', 'el id de la tarea debe ser la key original, no una nueva.');
});
