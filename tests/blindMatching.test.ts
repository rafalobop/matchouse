import test from 'node:test';
import assert from 'node:assert';
import {
  matchRequestAgainstProperties,
  mapDbRowToProperty,
  matchActiveSearchesAgainstProperty,
  findCrossTenantMatches,
  findMatchingActiveSearchesForProperty,
  ActiveSearchCandidate
} from '../src/services/blindMatching';
import { ExtractedRealEstateRequest } from '../src/services/ai';
import { Property } from '../src/services/excel';

function baseRequest(overrides: Partial<ExtractedRealEstateRequest> = {}): ExtractedRealEstateRequest {
  return {
    operation: 'venta',
    property_type: 'departamento',
    zones: [],
    max_budget: null,
    currency: 'ARS',
    bedrooms: null,
    key_features: [],
    country: 'indiferente',
    ...overrides
  };
}

function baseProperty(overrides: Partial<Property> = {}): Property {
  return {
    address: 'Av. Alem 500',
    price: 150000,
    currency: 'ARS',
    bedrooms: 2,
    features: '',
    property_type: 'departamento',
    operation: 'venta',
    sheet_name: 'Ventas',
    ...overrides
  };
}

test('BlindMatching - matchRequestAgainstProperties: descarta candidatos que no matchean (checkMatch isMatch=false)', () => {
  const request = baseRequest({ operation: 'venta' });
  const candidates = [
    { tenant_id: 'tenant-b', property: baseProperty({ operation: 'alquiler' }) }
  ];

  const result = matchRequestAgainstProperties(request, candidates);

  assert.strictEqual(result.length, 0, 'Una propiedad con operación distinta no debe aparecer en los resultados.');
});

test('BlindMatching - matchRequestAgainstProperties: atribuye el tenant_id correcto a cada match', () => {
  const request = baseRequest();
  const candidates = [
    { tenant_id: 'tenant-b', property: baseProperty({ address: 'Prop de B' }) }
  ];

  const result = matchRequestAgainstProperties(request, candidates);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].tenant_id, 'tenant-b');
  assert.strictEqual(result[0].property.address, 'Prop de B');
});

test('BlindMatching - matchRequestAgainstProperties: ordena los resultados de mayor a menor score', () => {
  const request = baseRequest({ key_features: ['pileta'] });
  const candidates = [
    { tenant_id: 'tenant-low', property: baseProperty({ address: 'Sin pileta', features: 'Living amplio' }) },
    { tenant_id: 'tenant-high', property: baseProperty({ address: 'Con pileta', features: 'Cuenta con pileta climatizada' }) }
  ];

  const result = matchRequestAgainstProperties(request, candidates);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].tenant_id, 'tenant-high', 'El match con mejor score (características coincidentes) debe ir primero.');
  assert.ok(result[0].score > result[1].score);
});

test('BlindMatching - matchRequestAgainstProperties: excluye implícitamente la cartera propia si el caller no la incluye en los candidatos', () => {
  // findCrossTenantMatches es quien filtra con .neq('tenant_id', tenantId) a nivel de query;
  // esta función pura solo debe operar sobre lo que recibe, sin conocer el tenant que busca.
  const request = baseRequest();
  const result = matchRequestAgainstProperties(request, []);

  assert.deepStrictEqual(result, []);
});

// Regresión (hallazgo de QA en KAN-37): mapDbRowToProperty() no seteaba zone_display_name al
// reconstruir un Property desde una fila de `properties`, a diferencia de los otros dos lugares
// del repo que hacen ese mismo trabajo (src/index.ts#main(), src/services/whatsapp.ts). Efecto
// real observado por QA: una búsqueda con zona nunca matcheaba ninguna propiedad cross-tenant,
// aunque coincidiera en todo lo demás (operación, tipo, dormitorios, presupuesto, características).
test('BlindMatching - mapDbRowToProperty: reconstruye zone_display_name a partir de sheet_name (regresión QA KAN-37)', () => {
  const row = { sheet_name: 'Alquiler YB', address: 'Calle Test 123', price: 1000, currency: 'USD', bedrooms: 1, operation: 'alquiler', property_type: 'departamento' };

  const property = mapDbRowToProperty(row);

  assert.strictEqual(property.zone_display_name, 'Alquiler YB', 'zone_display_name debe reconstruirse desde sheet_name, igual que en index.ts y whatsapp.ts.');
});

test('BlindMatching - findCrossTenantMatches (regresión QA KAN-37): una búsqueda con zona matchea una propiedad cross-tenant cuya zona coincide', () => {
  const dbRow = {
    tenant_id: 'tenant-b',
    address: 'Yerba Buena 1500',
    price: 120000,
    currency: 'USD',
    maintenance_fees: 0,
    bedrooms: 2,
    features: 'Pileta y cochera',
    contact_info: '',
    operation: 'venta',
    property_type: 'departamento',
    sheet_name: 'Yerba Buena',
    latitude: 0,
    longitude: 0
  };

  const candidate = { tenant_id: dbRow.tenant_id, property: mapDbRowToProperty(dbRow) };
  const request = baseRequest({ zones: ['Yerba Buena'], key_features: ['pileta', 'cochera'], bedrooms: 2, max_budget: 150000, currency: 'USD' });

  const result = matchRequestAgainstProperties(request, [candidate]);

  assert.strictEqual(result.length, 1, 'Antes del fix, esta búsqueda con zona no devolvía ningún match aunque coincidiera en todo lo demás.');
  assert.strictEqual(result[0].tenant_id, 'tenant-b');
});

// KAN-79: mock mínimo de query builder encadenable, mismo estilo que tests/searchExpiration.ts —
// distingue entre la tabla 'properties' (termina en .single()) y 'active_searches' (thenable, el
// query builder real de supabase-js se puede awaitear directo sin .select()/.single() final).
function makeCrossTenantMockClient(options: {
  propertyRow?: any;
  propertyError?: any;
  searchRows?: any[];
  searchError?: any;
} = {}) {
  const calls: { table: string; method: string; args: any[] }[] = [];

  function propertiesBuilder() {
    const builder: any = {
      select: (...args: any[]) => { calls.push({ table: 'properties', method: 'select', args }); return builder; },
      eq: (...args: any[]) => { calls.push({ table: 'properties', method: 'eq', args }); return builder; },
      single: () => {
        calls.push({ table: 'properties', method: 'single', args: [] });
        return Promise.resolve({ data: options.propertyRow ?? null, error: options.propertyError ?? null });
      }
    };
    return builder;
  }

  function activeSearchesBuilder() {
    const builder: any = {
      select: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'select', args }); return builder; },
      eq: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'eq', args }); return builder; },
      neq: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'neq', args }); return builder; },
      or: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'or', args }); return builder; },
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: options.searchRows ?? [], error: options.searchError ?? null }).then(resolve, reject)
    };
    return builder;
  }

  return {
    from: (table: string) => (table === 'properties' ? propertiesBuilder() : activeSearchesBuilder()),
    calls
  };
}

// Mock análogo, pero para findCrossTenantMatches (una sola tabla, 'properties', thenable directo
// sin .single()).
function makePropertiesOnlyMockClient(options: { rows?: any[]; error?: any } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const builder: any = {
    select: (...args: any[]) => { calls.push({ method: 'select', args }); return builder; },
    neq: (...args: any[]) => { calls.push({ method: 'neq', args }); return builder; },
    eq: (...args: any[]) => { calls.push({ method: 'eq', args }); return builder; },
    then: (resolve: any, reject: any) =>
      Promise.resolve({ data: options.rows ?? [], error: options.error ?? null }).then(resolve, reject)
  };
  return {
    from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder; },
    calls
  };
}

test('BlindMatching (KAN-79 AC1) - findCrossTenantMatches agrega el filtro SQL property_type cuando el pedido especifica un tipo concreto', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: [] });
  const request = baseRequest({ operation: 'venta', property_type: 'casa' });

  await findCrossTenantMatches('tenant-a', request, undefined, mockClient as any);

  const eqCalls = mockClient.calls.filter(c => c.method === 'eq');
  assert.deepStrictEqual(eqCalls.map(c => c.args), [['operation', 'venta'], ['property_type', 'casa']]);
});

test('BlindMatching (KAN-79 AC1) - findCrossTenantMatches NO filtra property_type en SQL cuando el pedido es "otro" (comodín)', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: [] });
  const request = baseRequest({ operation: 'venta', property_type: 'otro' });

  await findCrossTenantMatches('tenant-a', request, undefined, mockClient as any);

  const eqCalls = mockClient.calls.filter(c => c.method === 'eq');
  assert.deepStrictEqual(eqCalls.map(c => c.args), [['operation', 'venta']]);
});

test('BlindMatching (KAN-79) - matchActiveSearchesAgainstProperty: descarta candidatos que no matchean', () => {
  const property = baseProperty({ operation: 'venta' });
  const candidates: ActiveSearchCandidate[] = [
    { tenant_id: 'tenant-b', search_id: 'search-1', raw_text: 'busco algo', criteria: baseRequest({ operation: 'alquiler' }) }
  ];

  const result = matchActiveSearchesAgainstProperty(property, candidates);

  assert.strictEqual(result.length, 0, 'Una búsqueda con operación distinta no debe aparecer en los resultados.');
});

test('BlindMatching (KAN-79) - matchActiveSearchesAgainstProperty: atribuye tenant_id/search_id/raw_text correctos y ordena por score', () => {
  // La propiedad tiene pileta pero no cochera: la búsqueda que pide 'cochera' (característica
  // faltante) debe puntuar peor que la que pide 'pileta' (característica presente).
  const property = baseProperty({ features: 'Cuenta con pileta climatizada' });
  const candidates: ActiveSearchCandidate[] = [
    { tenant_id: 'tenant-low', search_id: 'search-low', raw_text: 'busco con cochera', criteria: baseRequest({ key_features: ['cochera'] }) },
    { tenant_id: 'tenant-high', search_id: 'search-high', raw_text: 'busco con pileta', criteria: baseRequest({ key_features: ['pileta'] }) }
  ];

  const result = matchActiveSearchesAgainstProperty(property, candidates);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].tenant_id, 'tenant-high');
  assert.strictEqual(result[0].search_id, 'search-high');
  assert.strictEqual(result[0].raw_text, 'busco con pileta');
  assert.ok(result[0].score > result[1].score);
});

test('BlindMatching (KAN-79) - matchActiveSearchesAgainstProperty: array vacío si no hay candidatos', () => {
  const property = baseProperty();
  assert.deepStrictEqual(matchActiveSearchesAgainstProperty(property, []), []);
});

test('BlindMatching (KAN-79) - findMatchingActiveSearchesForProperty: devuelve null y no consulta active_searches si la propiedad no existe', async () => {
  const mockClient = makeCrossTenantMockClient({ propertyRow: null, propertyError: { message: 'no encontrada' } });

  const result = await findMatchingActiveSearchesForProperty('prop-1', mockClient as any);

  assert.strictEqual(result, null);
  assert.ok(!mockClient.calls.some(c => c.table === 'active_searches'), 'No debe consultar active_searches si la propiedad no se pudo cargar.');
});

test('BlindMatching (KAN-79) - findMatchingActiveSearchesForProperty: prefiltra por status=active, tenant_id != dueño, y el comodín operation/property_type', async () => {
  const propertyRow = {
    id: 'prop-1', tenant_id: 'tenant-owner', address: 'Calle Nueva 100', price: 100000, currency: 'USD',
    bedrooms: 2, operation: 'venta', property_type: 'casa', sheet_name: 'Ventas'
  };
  const mockClient = makeCrossTenantMockClient({ propertyRow, searchRows: [] });

  await findMatchingActiveSearchesForProperty('prop-1', mockClient as any);

  const searchCalls = mockClient.calls.filter(c => c.table === 'active_searches');
  assert.deepStrictEqual(searchCalls.find(c => c.method === 'eq')?.args, ['status', 'active']);
  assert.deepStrictEqual(searchCalls.find(c => c.method === 'neq')?.args, ['tenant_id', 'tenant-owner']);
  const orArgs = searchCalls.filter(c => c.method === 'or').map(c => c.args[0]);
  assert.deepStrictEqual(orArgs, [
    'criteria->>operation.eq.desconocido,criteria->>operation.eq.venta',
    'criteria->>property_type.eq.otro,criteria->>property_type.eq.casa'
  ]);
});

test('BlindMatching (KAN-79) - findMatchingActiveSearchesForProperty: mapea las filas de active_searches y devuelve los matches', async () => {
  const propertyRow = {
    id: 'prop-1', tenant_id: 'tenant-owner', address: 'Calle Nueva 100', price: 100000, currency: 'USD',
    bedrooms: 2, operation: 'venta', property_type: 'casa', sheet_name: 'Ventas'
  };
  const searchRows = [
    { id: 'search-1', tenant_id: 'tenant-searcher', raw_text: 'busco casa', criteria: baseRequest({ operation: 'venta', property_type: 'casa' }) }
  ];
  const mockClient = makeCrossTenantMockClient({ propertyRow, searchRows });

  const result = await findMatchingActiveSearchesForProperty('prop-1', mockClient as any);

  assert.ok(result);
  assert.strictEqual(result!.tenantId, 'tenant-owner');
  assert.strictEqual(result!.matches.length, 1);
  assert.strictEqual(result!.matches[0].tenant_id, 'tenant-searcher');
  assert.strictEqual(result!.matches[0].search_id, 'search-1');
});

test('BlindMatching (KAN-79) - findMatchingActiveSearchesForProperty: propaga errores de la query de active_searches', async () => {
  const propertyRow = {
    id: 'prop-1', tenant_id: 'tenant-owner', address: 'Calle Nueva 100', price: 100000, currency: 'USD',
    bedrooms: 2, operation: 'venta', property_type: 'casa', sheet_name: 'Ventas'
  };
  const mockClient = makeCrossTenantMockClient({ propertyRow, searchError: { message: 'fallo simulado' } });

  await assert.rejects(() => findMatchingActiveSearchesForProperty('prop-1', mockClient as any));
});
