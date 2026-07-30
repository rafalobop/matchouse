import test from 'node:test';
import assert from 'node:assert';
import {
  buildBlindMatchInsertRows,
  mapBlindMatchRowToDashboardShape,
  mapIncomingMatchRowToDashboardShape,
  groupMatchesByMatchedTenant,
  MappedBlindMatch
} from '../src/utils/blindMatchPersistence';

function sampleMappedMatch(overrides: Partial<MappedBlindMatch> = {}): MappedBlindMatch {
  return {
    tenant_id: 'owner-1',
    score: 85,
    reasons: ['Coincidencia de zona', 'Coincidencia de dormitorios'],
    property: { domicilio: 'Av. Alem 500', precio: 150000, moneda: 'ARS' },
    ...overrides
  };
}

const sampleSearcherSnapshot = { full_name: 'Juan Perez', phone_number: '5493815551234', agency_name: 'Inmobiliaria Test' };

test('buildBlindMatchInsertRows - arma una fila por match con todos los campos', () => {
  const rows = buildBlindMatchInsertRows('searcher-1', 'search-1', 'Busco depto', sampleSearcherSnapshot, [sampleMappedMatch()]);

  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    tenant_id: 'searcher-1',
    search_id: 'search-1',
    matched_tenant_id: 'owner-1',
    raw_search_text: 'Busco depto',
    property_snapshot: sampleMappedMatch().property,
    searcher_snapshot: sampleSearcherSnapshot,
    score: 85,
    reasons: ['Coincidencia de zona', 'Coincidencia de dormitorios']
  });
});

test('buildBlindMatchInsertRows - array vacio devuelve array vacio', () => {
  const rows = buildBlindMatchInsertRows('searcher-1', 'search-1', 'Busco depto', sampleSearcherSnapshot, []);
  assert.deepStrictEqual(rows, []);
});

test('buildBlindMatchInsertRows - reasons faltante default a array vacio', () => {
  const match = sampleMappedMatch();
  delete (match as any).reasons;
  const rows = buildBlindMatchInsertRows('searcher-1', 'search-1', 'Busco depto', sampleSearcherSnapshot, [match]);
  assert.deepStrictEqual(rows[0].reasons, []);
});

test('mapBlindMatchRowToDashboardShape - shape correcto para el buscador', () => {
  const row = {
    id: 'match-1',
    created_at: '2026-07-29T12:00:00.000Z',
    raw_search_text: 'Busco depto 2 dorm',
    property_snapshot: { domicilio: 'Av. Alem 500' },
    score: 90,
    reasons: ['Coincide zona'],
    user_review_status: 'REJECTED',
    feedback_reason: 'Precio incompatible'
  };

  const mapped = mapBlindMatchRowToDashboardShape(row);

  assert.strictEqual(mapped.id, 'match-1');
  assert.strictEqual(mapped.searchText, 'Busco depto 2 dorm');
  assert.deepStrictEqual(mapped.property, { domicilio: 'Av. Alem 500' });
  assert.strictEqual(mapped.score, 90);
  assert.deepStrictEqual(mapped.reasons, ['Coincide zona']);
  assert.strictEqual(mapped.userReviewStatus, 'REJECTED');
  assert.strictEqual(mapped.feedbackReason, 'Precio incompatible');
  assert.ok(typeof mapped.fecha === 'string' && mapped.fecha.length > 0);
});

test('mapBlindMatchRowToDashboardShape - user_review_status null mapea a PENDING', () => {
  const row = {
    id: 'match-1',
    created_at: '2026-07-29T12:00:00.000Z',
    raw_search_text: 'Busco depto',
    property_snapshot: {},
    score: 50,
    reasons: [],
    user_review_status: null,
    feedback_reason: null
  };

  const mapped = mapBlindMatchRowToDashboardShape(row);

  assert.strictEqual(mapped.userReviewStatus, 'PENDING');
  assert.strictEqual(mapped.feedbackReason, null);
});

test('mapIncomingMatchRowToDashboardShape - shape correcto para el dueño de la propiedad, sin userReviewStatus/feedbackReason', () => {
  const row = {
    id: 'match-1',
    created_at: '2026-07-29T12:00:00.000Z',
    raw_search_text: 'Busco depto 2 dorm',
    property_snapshot: { domicilio: 'Av. Alem 500' },
    searcher_snapshot: sampleSearcherSnapshot,
    score: 90,
    reasons: ['Coincide zona']
  };

  const mapped: any = mapIncomingMatchRowToDashboardShape(row);

  assert.strictEqual(mapped.id, 'match-1');
  assert.strictEqual(mapped.searchText, 'Busco depto 2 dorm');
  assert.deepStrictEqual(mapped.searcherContact, sampleSearcherSnapshot);
  assert.deepStrictEqual(mapped.property, { domicilio: 'Av. Alem 500' });
  assert.strictEqual(mapped.score, 90);
  assert.strictEqual(mapped.userReviewStatus, undefined, 'No debe exponer userReviewStatus: la curación es exclusiva del buscador.');
  assert.strictEqual(mapped.feedbackReason, undefined, 'No debe exponer feedbackReason: la curación es exclusiva del buscador.');
});

test('groupMatchesByMatchedTenant - agrupa varios matches del mismo dueño', () => {
  const matches = [
    sampleMappedMatch({ tenant_id: 'owner-1' }),
    sampleMappedMatch({ tenant_id: 'owner-1' }),
    sampleMappedMatch({ tenant_id: 'owner-2' })
  ];

  const grouped = groupMatchesByMatchedTenant(matches);

  assert.strictEqual(Object.keys(grouped).length, 2);
  assert.strictEqual(grouped['owner-1'].length, 2);
  assert.strictEqual(grouped['owner-2'].length, 1);
});

test('groupMatchesByMatchedTenant - array vacio devuelve objeto vacio', () => {
  assert.deepStrictEqual(groupMatchesByMatchedTenant([]), {});
});
