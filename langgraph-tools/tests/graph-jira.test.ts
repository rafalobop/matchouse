import test from 'node:test';
import assert from 'node:assert';
import { adfToPlainText, parseJiraIssueResponse, buildTaskDescriptionAdf } from '../src/graph/jira';

// adfToPlainText y parseJiraIssueResponse son funciones puras (sin fetch), así
// que se testean con fixtures a mano sin mockear la red, igual que normalizeSpec
// en graph-po.test.ts.

test('graph/jira - adfToPlainText concatena párrafos con salto de línea', () => {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Primer párrafo.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Segundo párrafo.' }] }
    ]
  };

  assert.strictEqual(adfToPlainText(doc), 'Primer párrafo.\nSegundo párrafo.');
});

test('graph/jira - adfToPlainText devuelve string vacío ante description null/undefined', () => {
  assert.strictEqual(adfToPlainText(null), '');
  assert.strictEqual(adfToPlainText(undefined), '');
});

test('graph/jira - adfToPlainText concatena múltiples nodos de texto dentro del mismo párrafo', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hola ' }, { type: 'text', text: 'mundo.' }] }
    ]
  };

  assert.strictEqual(adfToPlainText(doc), 'Hola mundo.');
});

test('graph/jira - parseJiraIssueResponse extrae key/issueType/summary/descriptionText', () => {
  const raw = {
    key: 'HOUSE-42',
    fields: {
      summary: 'Implementar matching espacial',
      issuetype: { name: 'Story' },
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Detalle de la historia.' }] }]
      }
    }
  };

  const parsed = parseJiraIssueResponse(raw);

  assert.strictEqual(parsed.key, 'HOUSE-42');
  assert.strictEqual(parsed.issueType, 'Story');
  assert.strictEqual(parsed.summary, 'Implementar matching espacial');
  assert.strictEqual(parsed.descriptionText, 'Detalle de la historia.');
});

test('graph/jira - parseJiraIssueResponse cae a defaults ante una respuesta incompleta (sin issuetype ni description)', () => {
  const parsed = parseJiraIssueResponse({ key: 'HOUSE-7', fields: { summary: 'Tarea suelta' } });

  assert.strictEqual(parsed.key, 'HOUSE-7');
  assert.strictEqual(parsed.issueType, 'Task', 'Sin issuetype, debe caer a "Task" por defecto.');
  assert.strictEqual(parsed.summary, 'Tarea suelta');
  assert.strictEqual(parsed.descriptionText, '');
});

test('graph/jira - buildTaskDescriptionAdf arma un párrafo con el DoD + bulletList con los criterios (round-trip vía adfToPlainText)', () => {
  const adf = buildTaskDescriptionAdf('El endpoint responde 200 con el payload esperado', [
    'Devuelve 400 ante un body inválido',
    'Devuelve 404 si el recurso no existe'
  ]);

  const plainText = adfToPlainText(adf);

  assert.match(plainText, /El endpoint responde 200 con el payload esperado/);
  assert.match(plainText, /Devuelve 400 ante un body inválido/);
  assert.match(plainText, /Devuelve 404 si el recurso no existe/);
});

test('graph/jira - buildTaskDescriptionAdf no agrega bulletList si no hay acceptanceCriteria', () => {
  const adf: any = buildTaskDescriptionAdf('DoD sin criterios', []);

  assert.strictEqual(adf.content.length, 1, 'Sin criterios, el doc debe tener solo el párrafo del DoD.');
  assert.strictEqual(adf.content[0].type, 'paragraph');
});
