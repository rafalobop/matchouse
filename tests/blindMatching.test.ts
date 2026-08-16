import test from 'node:test';
import assert from 'node:assert';
import {
  matchRequestAgainstProperties,
  mapDbRowToProperty,
  matchActiveSearchesAgainstProperty,
  findCrossTenantMatches,
  findMatchingActiveSearchesForProperty,
  ActiveSearchCandidate,
  MAX_CROSS_TENANT_MATCHES,
  MAX_QUERY_ROWS
} from '../src/services/blindMatching';
import { ExtractedRealEstateRequest, ZoneIntentRequest } from '../src/services/ai';
import { Property } from '../src/services/excel';
import { __clearZoneKeywordCacheForTests } from '../src/services/zonesService';

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

function baseZoneIntent(overrides: Partial<ZoneIntentRequest> = {}): ZoneIntentRequest {
  return {
    zone_status: 'INDEFINIDA',
    zona_ids: [],
    zona_nombres: [],
    texto_ubicacion_original: '',
    dormitorios_min: null,
    caracteristicas_claves: [],
    operacion: 'DESCONOCIDO',
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
// Extendido (2026-08-11) con 'neighborhoods'/'neighborhood_aliases' (usadas por el self-healing de
// zonas DESCONOCIDA vía resolveMultipleNeighborhoodsByText/resolvePropertyZoneId) y un `.update()`
// encadenable sobre 'active_searches' para capturar la persistencia de la curación.
function makeCrossTenantMockClient(options: {
  propertyRow?: any;
  propertyError?: any;
  searchRows?: any[];
  searchError?: any;
  neighborhoodRows?: any[];
  aliasRows?: any[];
  rpcRows?: any[];
} = {}) {
  const calls: { table: string; method: string; args: any[] }[] = [];
  const updateCalls: { table: string; payload: any; eqArgs: any[] }[] = [];

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
      update: (payload: any) => {
        calls.push({ table: 'active_searches', method: 'update', args: [payload] });
        return {
          eq: (...eqArgs: any[]) => {
            updateCalls.push({ table: 'active_searches', payload, eqArgs });
            return Promise.resolve({ error: null });
          }
        };
      },
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: options.searchRows ?? [], error: options.searchError ?? null }).then(resolve, reject)
    };
    return builder;
  }

  function simpleSelectBuilder(table: string, rows: any[]) {
    return {
      select: (...args: any[]) => {
        calls.push({ table, method: 'select', args });
        return Promise.resolve({ data: rows, error: null });
      }
    };
  }

  return {
    from: (table: string) => {
      if (table === 'properties') return propertiesBuilder();
      if (table === 'active_searches') return activeSearchesBuilder();
      if (table === 'neighborhoods') return simpleSelectBuilder('neighborhoods', options.neighborhoodRows ?? []);
      if (table === 'neighborhood_aliases') return simpleSelectBuilder('neighborhood_aliases', options.aliasRows ?? []);
      return activeSearchesBuilder();
    },
    rpc: (fn: string, params: any) => {
      calls.push({ table: 'rpc', method: fn, args: [params] });
      return Promise.resolve({ data: options.rpcRows ?? [], error: null });
    },
    calls,
    updateCalls
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
    limit: (...args: any[]) => { calls.push({ method: 'limit', args }); return builder; },
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

// --- Paginación cross-tenant (KAN-133) ---

// Genera N filas de `properties` que matchean la baseRequest por defecto (venta/departamento),
// cada una con su propio tenant_id/address para poder distinguirlas en las aserciones de página.
function makeMatchingRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    tenant_id: `tenant-${i}`,
    address: `Propiedad ${i}`,
    price: 150000,
    currency: 'ARS',
    bedrooms: 2,
    features: '',
    contact_info: '',
    operation: 'venta',
    property_type: 'departamento',
    sheet_name: 'Ventas',
    latitude: 0,
    longitude: 0
  }));
}

test('BlindMatching (KAN-133) - findCrossTenantMatches acota la query SQL con .limit(MAX_QUERY_ROWS), independiente de la paginación de resultados', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: [] });

  await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any);

  const limitCall = mockClient.calls.find(c => c.method === 'limit');
  assert.ok(limitCall, 'La query cross-tenant debe tener un .limit() explícito.');
  assert.deepStrictEqual(limitCall!.args, [MAX_QUERY_ROWS]);
});

test('BlindMatching (KAN-133, regresión) - sin pagination explícita, devuelve como máximo MAX_CROSS_TENANT_MATCHES resultados (comportamiento previo a KAN-133)', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: makeMatchingRows(MAX_CROSS_TENANT_MATCHES + 20) });

  const result = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any);

  assert.strictEqual(result.length, MAX_CROSS_TENANT_MATCHES, 'El tamaño de página por defecto no debe cambiar respecto al límite previo.');
});

test('BlindMatching (KAN-133) - un limit explícito devuelve como máximo N resultados', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: makeMatchingRows(30) });

  const result = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 10 });

  assert.strictEqual(result.length, 10);
});

test('BlindMatching (KAN-133) - offset + limit permiten transitar entre páginas sin solapamiento ni errores', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: makeMatchingRows(25) });

  const page1 = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 10, offset: 0 });
  const page2 = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 10, offset: 10 });
  const page3 = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 10, offset: 20 });

  assert.strictEqual(page1.length, 10);
  assert.strictEqual(page2.length, 10);
  assert.strictEqual(page3.length, 5, 'La última página trae solo lo que queda (25 - 20).');

  const seenTenants = new Set([...page1, ...page2, ...page3].map(m => m.tenant_id));
  assert.strictEqual(seenTenants.size, 25, 'Ninguna propiedad debe repetirse ni faltar entre las tres páginas.');
});

test('BlindMatching (KAN-133) - un offset más allá del total de resultados devuelve una página vacía sin error', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: makeMatchingRows(5) });

  const result = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 10, offset: 100 });

  assert.deepStrictEqual(result, []);
});

test('BlindMatching (KAN-133) - sin candidatos que matcheen, cualquier página es un array vacío sin error', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: [] });

  const result = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 10, offset: 0 });

  assert.deepStrictEqual(result, []);
});

test('BlindMatching (KAN-133) - parámetros de paginación inválidos (negativos, cero, no enteros) caen a los valores por defecto en vez de tirar error', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: makeMatchingRows(60) });

  const negativeLimit = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: -5, offset: 0 });
  const zeroLimit = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 0, offset: 0 });
  const decimalLimit = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 3.5, offset: 0 });
  const negativeOffset = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 10, offset: -1 });
  const nanLimit = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: NaN, offset: NaN });

  assert.strictEqual(negativeLimit.length, MAX_CROSS_TENANT_MATCHES, 'limit negativo debe caer al default.');
  assert.strictEqual(zeroLimit.length, MAX_CROSS_TENANT_MATCHES, 'limit en 0 debe caer al default.');
  assert.strictEqual(decimalLimit.length, MAX_CROSS_TENANT_MATCHES, 'limit no entero debe caer al default.');
  assert.strictEqual(negativeOffset.length, 10, 'offset negativo debe caer a 0, no filtrar el resultado.');
  assert.strictEqual(nanLimit.length, MAX_CROSS_TENANT_MATCHES, 'NaN debe caer al default tanto en limit como en offset.');
});

test('BlindMatching (KAN-133) - un limit por encima del tope duro (MAX_PAGE_SIZE) se acota, no se ignora', async () => {
  const mockClient = makePropertiesOnlyMockClient({ rows: makeMatchingRows(300) });

  const result = await findCrossTenantMatches('tenant-a', baseRequest(), undefined, mockClient as any, { limit: 10000 });

  assert.ok(result.length <= 200, 'Un limit desmedido no debe devolver más de MAX_PAGE_SIZE resultados.');
});

test('BlindMatching (KAN-79) - matchActiveSearchesAgainstProperty: descarta candidatos que no matchean', () => {
  const property = baseProperty({ operation: 'venta' });
  const candidates: ActiveSearchCandidate[] = [
    { tenant_id: 'tenant-b', search_id: 'search-1', raw_text: 'busco algo', criteria: baseRequest({ operation: 'alquiler' }), zoneIntent: baseZoneIntent() }
  ];

  const result = matchActiveSearchesAgainstProperty(property, candidates);

  assert.strictEqual(result.length, 0, 'Una búsqueda con operación distinta no debe aparecer en los resultados.');
});

test('BlindMatching (KAN-79) - matchActiveSearchesAgainstProperty: atribuye tenant_id/search_id/raw_text correctos y ordena por score', () => {
  // La propiedad tiene pileta pero no cochera: la búsqueda que pide 'cochera' (característica
  // faltante) debe puntuar peor que la que pide 'pileta' (característica presente).
  const property = baseProperty({ features: 'Cuenta con pileta climatizada' });
  const candidates: ActiveSearchCandidate[] = [
    { tenant_id: 'tenant-low', search_id: 'search-low', raw_text: 'busco con cochera', criteria: baseRequest({ key_features: ['cochera'] }), zoneIntent: baseZoneIntent() },
    { tenant_id: 'tenant-high', search_id: 'search-high', raw_text: 'busco con pileta', criteria: baseRequest({ key_features: ['pileta'] }), zoneIntent: baseZoneIntent() }
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

// --- Self-healing de zonas DESCONOCIDA (2026-08-11) ---

test('BlindMatching (self-healing) - una búsqueda DESCONOCIDA cuya zona ahora resuelve se cura (UPDATE) y matchea la propiedad nueva', async () => {
  __clearZoneKeywordCacheForTests();
  const propertyRow = {
    id: 'prop-1', tenant_id: 'tenant-owner', address: 'Villa Lujan 100', price: 100000, currency: 'USD',
    bedrooms: 2, operation: 'venta', property_type: 'casa', sheet_name: 'Ventas'
  };
  const searchRows = [{
    id: 'search-1', tenant_id: 'tenant-searcher', raw_text: 'busco casa en villa lujan',
    criteria: baseRequest({ operation: 'venta', property_type: 'casa' }),
    zone_status: 'DESCONOCIDA', zone_ids: [], zone_names: [], zone_text_original: 'villa lujan'
  }];
  const mockClient = makeCrossTenantMockClient({
    propertyRow,
    searchRows,
    neighborhoodRows: [{ id: 'n-lujan', name: 'Villa Lujan' }],
    aliasRows: []
  });

  const result = await findMatchingActiveSearchesForProperty('prop-1', mockClient as any);

  assert.ok(result);
  assert.strictEqual(result!.matches.length, 1, 'Tras curarse, la búsqueda debe matchear la propiedad recién cargada (misma zona).');
  assert.strictEqual(result!.matches[0].search_id, 'search-1');

  const updateCall = (mockClient as any).updateCalls.find((c: any) => c.eqArgs[1] === 'search-1');
  assert.ok(updateCall, 'Debe persistir la curación con un UPDATE sobre la fila de active_searches.');
  assert.strictEqual(updateCall.payload.zone_status, 'DEFINIDA');
  assert.deepStrictEqual(updateCall.payload.zone_ids, ['n-lujan']);
  assert.deepStrictEqual(updateCall.payload.zone_names, ['Villa Lujan']);
});

test('BlindMatching (self-healing) - una búsqueda DESCONOCIDA que sigue sin resolver no se persiste (sin UPDATE) y no matchea', async () => {
  __clearZoneKeywordCacheForTests();
  const propertyRow = {
    id: 'prop-1', tenant_id: 'tenant-owner', address: 'Calle Nueva 100', price: 100000, currency: 'USD',
    bedrooms: 2, operation: 'venta', property_type: 'casa', sheet_name: 'Ventas'
  };
  const searchRows = [{
    id: 'search-1', tenant_id: 'tenant-searcher', raw_text: 'busco casa en planeta marte',
    criteria: baseRequest({ operation: 'venta', property_type: 'casa' }),
    zone_status: 'DESCONOCIDA', zone_ids: [], zone_names: [], zone_text_original: 'planeta marte'
  }];
  const mockClient = makeCrossTenantMockClient({
    propertyRow,
    searchRows,
    neighborhoodRows: [{ id: 'n-lujan', name: 'Villa Lujan' }],
    aliasRows: []
  });

  const result = await findMatchingActiveSearchesForProperty('prop-1', mockClient as any);

  assert.ok(result);
  assert.strictEqual(result!.matches.length, 0, 'DESCONOCIDA sin resolver sigue siendo un filtro duro: no debe matchear.');
  assert.strictEqual((mockClient as any).updateCalls.length, 0, 'No debe reescribir la fila si sigue sin resolver (evita UPDATEs vacíos repetidos).');
});

test('BlindMatching (self-healing) - una búsqueda ya DEFINIDA no dispara ningún trabajo de self-healing', async () => {
  __clearZoneKeywordCacheForTests();
  const propertyRow = {
    id: 'prop-1', tenant_id: 'tenant-owner', address: 'Villa Lujan 100', price: 100000, currency: 'USD',
    bedrooms: 2, operation: 'venta', property_type: 'casa', sheet_name: 'Ventas'
  };
  const searchRows = [{
    id: 'search-1', tenant_id: 'tenant-searcher', raw_text: 'busco casa en villa lujan',
    criteria: baseRequest({ operation: 'venta', property_type: 'casa' }),
    zone_status: 'DEFINIDA', zone_ids: ['n-lujan'], zone_names: ['Villa Lujan'], zone_text_original: 'villa lujan'
  }];
  const mockClient = makeCrossTenantMockClient({
    propertyRow,
    searchRows,
    neighborhoodRows: [{ id: 'n-lujan', name: 'Villa Lujan' }],
    aliasRows: []
  });

  const result = await findMatchingActiveSearchesForProperty('prop-1', mockClient as any);

  assert.ok(result);
  assert.strictEqual(result!.matches.length, 1, 'Ya estaba DEFINIDA y la propiedad cae en la misma zona: debe matchear directo, sin self-healing.');
  assert.strictEqual((mockClient as any).updateCalls.length, 0, 'No hay nada que curar si ya estaba DEFINIDA.');
});
