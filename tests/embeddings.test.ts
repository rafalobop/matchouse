import test from 'node:test';
import assert from 'node:assert';
import {
  generateEmbeddings,
  generateEmbedding,
  toPgVectorLiteral,
  buildNeighborhoodEmbeddingText,
  EmbeddingServiceError,
  __setOpenAIEmbeddingsClientForTests
} from '../src/services/embeddings';

// Cada test de este archivo instala su propio fake con `__setOpenAIEmbeddingsClientForTests`
// (variable de módulo global, compartida por todo el proceso de `pnpm test`) — este `after` evita
// que el último fake quede pisado para los archivos de test que corren después en el mismo
// proceso (ej. zonesService.test.ts, que depende del guard global a `null` de tests/runner.ts).
test.after(() => {
  __setOpenAIEmbeddingsClientForTests(null);
});

// BE-19 (EP-07): fake de la forma mínima que `generateEmbeddings` consume de un cliente real de
// OpenAI (`openai.embeddings.create`) — mismo criterio de inyección que el resto del repo
// (fakeSupabaseClient, __setResendClientForTests): nunca pegarle a la API real desde un test.
function fakeOpenAI(createImpl: (params: { input: string[] }) => Promise<{ data: { embedding: number[]; index: number }[] }>) {
  return { embeddings: { create: createImpl } } as any;
}

test('generateEmbeddings - devuelve un embedding por texto, en el mismo orden que el input', async () => {
  __setOpenAIEmbeddingsClientForTests(
    fakeOpenAI(async ({ input }) => ({
      data: input.map((_, index) => ({ embedding: [index, index + 1], index }))
    }))
  );

  const result = await generateEmbeddings(['a', 'b', 'c']);
  assert.deepStrictEqual(result, [[0, 1], [1, 2], [2, 3]]);
});

test('generateEmbeddings - reordena por el campo "index" de la respuesta en vez de asumir el orden del array (defensivo)', async () => {
  __setOpenAIEmbeddingsClientForTests(
    fakeOpenAI(async ({ input }) => ({
      // Respuesta deliberadamente fuera de orden respecto a `input`.
      data: [
        { embedding: [9, 9], index: 2 },
        { embedding: [7, 7], index: 0 },
        { embedding: [8, 8], index: 1 }
      ]
    }))
  );

  const result = await generateEmbeddings(['x', 'y', 'z']);
  assert.deepStrictEqual(result, [[7, 7], [8, 8], [9, 9]]);
});

test('generateEmbeddings - array vacío no llama al cliente', async () => {
  let called = false;
  __setOpenAIEmbeddingsClientForTests(fakeOpenAI(async () => { called = true; return { data: [] }; }));

  const result = await generateEmbeddings([]);
  assert.deepStrictEqual(result, []);
  assert.strictEqual(called, false);
});

test('generateEmbeddings - sin cliente configurado (sin OPENAI_API_KEY) lanza EmbeddingServiceError', async () => {
  __setOpenAIEmbeddingsClientForTests(null);
  await assert.rejects(() => generateEmbeddings(['texto']), EmbeddingServiceError);
});

test('generateEmbeddings - un error real del cliente se envuelve en EmbeddingServiceError', async () => {
  __setOpenAIEmbeddingsClientForTests(fakeOpenAI(async () => { throw new Error('500 de la API'); }));
  await assert.rejects(() => generateEmbeddings(['texto']), EmbeddingServiceError);
});

test('generateEmbedding (singular) - delega en generateEmbeddings y devuelve el primer resultado', async () => {
  __setOpenAIEmbeddingsClientForTests(
    fakeOpenAI(async ({ input }) => ({ data: input.map((_, index) => ({ embedding: [42], index })) }))
  );
  const result = await generateEmbedding('zona centro');
  assert.deepStrictEqual(result, [42]);
});

test('toPgVectorLiteral - formatea un array de números como literal de pgvector', () => {
  assert.strictEqual(toPgVectorLiteral([0.1, -0.2, 3]), '[0.1,-0.2,3]');
  assert.strictEqual(toPgVectorLiteral([]), '[]');
});

test('buildNeighborhoodEmbeddingText - normaliza el nombre técnico y concatena alias deduplicados', () => {
  assert.strictEqual(
    buildNeighborhoodEmbeddingText('ZONA_CENTRO', ['Centro', 'el centro', 'Centro']),
    'zona centro, centro, el centro'
  );
});

test('buildNeighborhoodEmbeddingText - sin alias, solo el nombre normalizado', () => {
  assert.strictEqual(buildNeighborhoodEmbeddingText('BARRIO_NORTE', []), 'barrio norte');
});
