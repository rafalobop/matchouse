import test from 'node:test';
import assert from 'node:assert';
import {
  resolveColumnMapping,
  confirmColumnMapping,
  toColumnMapRecord,
  ExcelMappingServiceError,
  HEURISTIC_CONFIDENCE_THRESHOLD
} from '../src/services/excelMapping';
import { ExcelColumnMappingSuggestion } from '../src/services/ai';

// Mock del builder encadenable de Supabase, acotado a las dos operaciones que usa
// excelMapping.ts: `select().eq().eq().maybeSingle()` (lectura del mapeo guardado) y
// `upsert(row, opts)` (persistencia best-effort del mapeo resuelto).
function buildMockClient(options: {
  storedResult?: { data: any; error: any };
  upsertResult?: { error: any };
  capturedUpserts?: any[];
}) {
  const storedResult = options.storedResult ?? { data: null, error: null };
  const upsertResult = options.upsertResult ?? { error: null };
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve(storedResult)
          })
        })
      }),
      upsert: (row: any) => {
        options.capturedUpserts?.push(row);
        return Promise.resolve(upsertResult);
      }
    })
  } as any;
}

function neverCalledAi(): (headers: string[]) => Promise<ExcelColumnMappingSuggestion[]> {
  return async () => {
    throw new Error('No debería haberse llamado a la IA en este escenario');
  };
}

test('resolveColumnMapping - reusa un mapeo ya confirmado sin llamar a la IA', async () => {
  const storedFields = [
    { field: 'domicilio', header: 'Dirección', confidence: 1, ambiguous: false, candidates: [] },
    { field: 'precio', header: 'Costo', confidence: 1, ambiguous: false, candidates: [] }
  ];
  const client = buildMockClient({
    storedResult: { data: { column_mapping: storedFields, confirmed: true, source: 'manual', confidence: 1 }, error: null }
  });

  const result = await resolveColumnMapping('tenant-1', ['Dirección', 'Costo'], client, neverCalledAi());

  assert.strictEqual(result.status, 'ready');
  if (result.status === 'ready') {
    assert.strictEqual(result.source, 'stored');
    assert.deepStrictEqual(result.fields, storedFields);
  }
});

test('resolveColumnMapping - headers estándar en español resuelven por heurística, sin llamar a la IA, y se persisten confirmados', async () => {
  const upserts: any[] = [];
  const client = buildMockClient({ capturedUpserts: upserts });

  const result = await resolveColumnMapping('tenant-1', ['Domicilio', 'Precio', 'Dormitorios'], client, neverCalledAi());

  assert.strictEqual(result.status, 'ready');
  if (result.status === 'ready') {
    assert.strictEqual(result.source, 'heuristic');
  }
  assert.strictEqual(upserts.length, 1);
  assert.strictEqual(upserts[0].confirmed, true);
  assert.strictEqual(upserts[0].source, 'heuristic');
});

test('resolveColumnMapping - headers no reconocidos escalan a IA, que resuelve con confianza suficiente', async () => {
  const upserts: any[] = [];
  const client = buildMockClient({ capturedUpserts: upserts });
  const aiSuggestFn = async (): Promise<ExcelColumnMappingSuggestion[]> => [
    { field: 'domicilio', header: 'Address', confidence: 0.9 },
    { field: 'precio', header: 'Price', confidence: 0.85 }
  ];

  const result = await resolveColumnMapping('tenant-1', ['Address', 'Price'], client, aiSuggestFn);

  assert.strictEqual(result.status, 'ready');
  if (result.status === 'ready') {
    assert.strictEqual(result.source, 'ai');
    const domicilio = result.fields.find(f => f.field === 'domicilio');
    assert.strictEqual(domicilio?.header, 'Address');
  }
  assert.strictEqual(upserts[0].confirmed, true);
  assert.strictEqual(upserts[0].source, 'ai');
});

test('resolveColumnMapping - la IA alucina un header inexistente: se descarta y el campo queda sin resolver', async () => {
  const client = buildMockClient({});
  const aiSuggestFn = async (): Promise<ExcelColumnMappingSuggestion[]> => [
    { field: 'domicilio', header: 'Columna Que No Existe', confidence: 0.95 },
    { field: 'precio', header: 'Price', confidence: 0.9 }
  ];

  const result = await resolveColumnMapping('tenant-1', ['Address', 'Price'], client, aiSuggestFn);

  assert.strictEqual(result.status, 'needs_confirmation');
  if (result.status === 'needs_confirmation') {
    assert.ok(result.unresolvedRequiredFields.includes('domicilio'), 'Un header alucinado por la IA nunca debe aceptarse como válido.');
  }
});

test('resolveColumnMapping - ni la heurística ni la IA resuelven -> needs_confirmation, persistido sin confirmar', async () => {
  const upserts: any[] = [];
  const client = buildMockClient({ capturedUpserts: upserts });
  const aiSuggestFn = async (): Promise<ExcelColumnMappingSuggestion[]> => [
    { field: 'domicilio', header: null, confidence: 0 },
    { field: 'precio', header: null, confidence: 0 }
  ];

  const result = await resolveColumnMapping('tenant-1', ['Columna X', 'Columna Y'], client, aiSuggestFn);

  assert.strictEqual(result.status, 'needs_confirmation');
  if (result.status === 'needs_confirmation') {
    assert.deepStrictEqual(result.unresolvedRequiredFields.sort(), ['domicilio', 'precio']);
  }
  assert.strictEqual(upserts[0].confirmed, false);
});

test('resolveColumnMapping - si la IA falla (throw), cae al resultado heurístico como needs_confirmation en vez de romper', async () => {
  const client = buildMockClient({});
  const aiSuggestFn = async (): Promise<ExcelColumnMappingSuggestion[]> => {
    throw new Error('Timeout simulado de IA');
  };

  const result = await resolveColumnMapping('tenant-1', ['Columna Rara'], client, aiSuggestFn);

  assert.strictEqual(result.status, 'needs_confirmation');
  if (result.status === 'needs_confirmation') {
    assert.strictEqual(result.source, 'heuristic');
  }
});

test('resolveColumnMapping - ambigüedad heurística en un campo opcional no bloquea el auto-confirmado si la IA desambigua con confianza suficiente', async () => {
  // Dos columnas ("Características"/"Caracteristicas") matchean el mismo campo opcional para la
  // heurística — eso por sí solo escala a IA (AC3: re-detección), pero como domicilio/precio no
  // están afectados y la IA sí logra elegir una con confianza suficiente, el resultado puede
  // auto-confirmarse igual (AC5: la IA como estrategia de desambiguación, no solo la confirmación
  // manual). Ver el test siguiente para el caso en que la IA TAMPOCO logra desambiguar.
  const client = buildMockClient({});
  const aiSuggestFn = async (): Promise<ExcelColumnMappingSuggestion[]> => [
    { field: 'domicilio', header: 'Domicilio', confidence: 0.9 },
    { field: 'precio', header: 'Precio', confidence: 0.9 },
    { field: 'caracteristicas', header: 'Características', confidence: 0.7 }
  ];

  const result = await resolveColumnMapping('tenant-1', ['Domicilio', 'Precio', 'Características', 'Caracteristicas'], client, aiSuggestFn);

  assert.strictEqual(result.status, 'ready');
  if (result.status === 'ready') {
    assert.strictEqual(result.source, 'ai');
  }
});

test('resolveColumnMapping - ambigüedad heurística en un campo REQUERIDO (columna duplicada) fuerza needs_confirmation si la IA tampoco logra resolverlo con confianza', async () => {
  const upserts: any[] = [];
  const client = buildMockClient({ capturedUpserts: upserts });
  // "Precio" aparece dos veces -> la heurística queda ambigua en un campo requerido. La IA, con
  // los mismos headers ambiguos, tampoco logra distinguir cuál es la columna correcta (confianza
  // baja) — ahí sí el AC5 exige pedirle confirmación al agente, no adivinar.
  const aiSuggestFn = async (): Promise<ExcelColumnMappingSuggestion[]> => [
    { field: 'domicilio', header: 'Domicilio', confidence: 0.9 },
    { field: 'precio', header: 'Precio', confidence: 0.3 }
  ];

  const result = await resolveColumnMapping('tenant-1', ['Domicilio', 'Precio', 'Precio'], client, aiSuggestFn);

  assert.strictEqual(result.status, 'needs_confirmation');
  if (result.status === 'needs_confirmation') {
    assert.ok(result.unresolvedRequiredFields.includes('precio'), 'Confianza de IA por debajo del umbral en un campo requerido debe tratarse como no resuelto.');
  }
  assert.strictEqual(upserts[0].confirmed, false);
});

test('HEURISTIC_CONFIDENCE_THRESHOLD está definido y es un número entre 0 y 1', () => {
  assert.strictEqual(typeof HEURISTIC_CONFIDENCE_THRESHOLD, 'number');
  assert.ok(HEURISTIC_CONFIDENCE_THRESHOLD > 0 && HEURISTIC_CONFIDENCE_THRESHOLD <= 1);
});

// --- confirmColumnMapping (AC4: confirmación/corrección manual del agente) ---

test('confirmColumnMapping - persiste el mapeo confirmado con source=manual y confirmed=true', async () => {
  const upserts: any[] = [];
  const client = buildMockClient({ capturedUpserts: upserts });

  const { fields } = await confirmColumnMapping(
    'tenant-1',
    ['Dirección', 'Costo', 'Ambientes'],
    { domicilio: 'Dirección', precio: 'Costo', dormitorios: 'Ambientes' },
    client
  );

  assert.strictEqual(upserts.length, 1);
  assert.strictEqual(upserts[0].source, 'manual');
  assert.strictEqual(upserts[0].confirmed, true);
  const domicilio = fields.find(f => f.field === 'domicilio');
  assert.strictEqual(domicilio?.header, 'Dirección');
  assert.strictEqual(domicilio?.confidence, 1);
});

test('confirmColumnMapping - rechaza si el mapeo corregido no resuelve los campos requeridos', async () => {
  const client = buildMockClient({});

  await assert.rejects(
    () => confirmColumnMapping('tenant-1', ['Dirección'], { domicilio: 'Dirección', precio: null }, client),
    (error: any) => {
      assert.ok(error instanceof ExcelMappingServiceError);
      assert.match(error.message, /precio/);
      return true;
    }
  );
});

test('confirmColumnMapping - un header confirmado que no existe en la hoja actual queda como null', async () => {
  const client = buildMockClient({});

  await assert.rejects(
    () => confirmColumnMapping('tenant-1', ['Dirección', 'Costo'], { domicilio: 'Dirección', precio: 'Columna Que No Existe' }, client),
    ExcelMappingServiceError
  );
});

test('toColumnMapRecord - convierte el arreglo de fields a un record field->header', () => {
  const record = toColumnMapRecord([
    { field: 'domicilio', header: 'Dirección', confidence: 1, ambiguous: false, candidates: [] },
    { field: 'precio', header: null, confidence: 0, ambiguous: false, candidates: [] }
  ]);

  assert.deepStrictEqual(record, { domicilio: 'Dirección', precio: null });
});
