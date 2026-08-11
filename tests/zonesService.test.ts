import test from 'node:test';
import assert from 'node:assert';
import {
  listNeighborhoodGroups,
  listNeighborhoods,
  findNeighborhoodByAlias,
  findNeighborhoodByPoint,
  resolveNeighborhoodIdByText,
  resolveNeighborhoodByText,
  resolveMultipleNeighborhoodsByText,
  resolvePropertyZoneId,
  __clearZoneKeywordCacheForTests,
  ZonesServiceError
} from '../src/services/zonesService';

// Mock minimo de un query builder de Supabase encadenable, mismo estilo que searchExpiration.test.ts.
function makeMockClient(options: { rows?: any; error?: any; single?: any } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const builder: any = {
    select: (...args: any[]) => { calls.push({ method: 'select', args }); return builder; },
    order: (...args: any[]) => {
      calls.push({ method: 'order', args });
      return Promise.resolve({ data: options.rows ?? [], error: options.error ?? null });
    },
    eq: (...args: any[]) => { calls.push({ method: 'eq', args }); return builder; },
    ilike: (...args: any[]) => { calls.push({ method: 'ilike', args }); return builder; },
    maybeSingle: (...args: any[]) => {
      calls.push({ method: 'maybeSingle', args });
      return Promise.resolve({ data: options.single ?? null, error: options.error ?? null });
    }
  };
  return {
    from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder; },
    rpc: (fn: string, params: any) => {
      calls.push({ method: 'rpc', args: [fn, params] });
      return Promise.resolve({ data: options.rows ?? [], error: options.error ?? null });
    },
    calls
  };
}

test('zonesService - expone las funciones esperadas', () => {
  assert.strictEqual(typeof listNeighborhoodGroups, 'function');
  assert.strictEqual(typeof listNeighborhoods, 'function');
  assert.strictEqual(typeof findNeighborhoodByAlias, 'function');
  assert.strictEqual(typeof findNeighborhoodByPoint, 'function');
});

test('listNeighborhoodGroups - consulta neighborhood_groups ordenado por nombre', async () => {
  const rows = [{ id: '1', name: 'Zonas', description: null }];
  const mockClient = makeMockClient({ rows });

  const result = await listNeighborhoodGroups(mockClient as any);

  assert.deepStrictEqual(mockClient.calls[0], { method: 'from', args: ['neighborhood_groups'] });
  assert.strictEqual(mockClient.calls[1].method, 'select');
  assert.deepStrictEqual(mockClient.calls[2], { method: 'order', args: ['name'] });
  assert.deepStrictEqual(result, rows);
});

test('listNeighborhoodGroups - propaga errores del cliente como ZonesServiceError', async () => {
  const mockClient = makeMockClient({ error: { message: 'fallo simulado' } });

  await assert.rejects(() => listNeighborhoodGroups(mockClient as any), ZonesServiceError);
});

test('listNeighborhoods - sin groupId no filtra por group_id', async () => {
  const mockClient = makeMockClient({ rows: [] });

  await listNeighborhoods(undefined, mockClient as any);

  assert.ok(!mockClient.calls.some((c) => c.method === 'eq'), 'No debe llamar a .eq() si no se pasa groupId.');
});

test('listNeighborhoods - con groupId filtra por group_id', async () => {
  const mockClient = makeMockClient({ rows: [] });

  await listNeighborhoods('group-1', mockClient as any);

  assert.ok(mockClient.calls.some((c) => c.method === 'eq' && c.args[0] === 'group_id' && c.args[1] === 'group-1'));
});

test('findNeighborhoodByAlias - normaliza a minúsculas y sin espacios extremos antes de consultar', async () => {
  const mockClient = makeMockClient({ single: { neighborhood_id: 'n1', neighborhoods: { id: 'n1', name: 'YERBA_BUENA', group_id: 'g1' } } });

  await findNeighborhoodByAlias('  Yerba Buena  ', mockClient as any);

  const ilikeCall = mockClient.calls.find((c) => c.method === 'ilike');
  assert.deepStrictEqual(ilikeCall!.args, ['alias', 'yerba buena']);
});

test('findNeighborhoodByAlias - devuelve el neighborhood embebido cuando hay match', async () => {
  const neighborhood = { id: 'n1', name: 'YERBA_BUENA', group_id: 'g1' };
  const mockClient = makeMockClient({ single: { neighborhood_id: 'n1', neighborhoods: neighborhood } });

  const result = await findNeighborhoodByAlias('yerba buena', mockClient as any);

  assert.deepStrictEqual(result, neighborhood);
});

test('findNeighborhoodByAlias - devuelve null (no error) si no hay ningún alias registrado', async () => {
  const mockClient = makeMockClient({ single: null });

  const result = await findNeighborhoodByAlias('zona inexistente', mockClient as any);

  assert.strictEqual(result, null);
});

test('findNeighborhoodByAlias - alias vacío devuelve null sin consultar la base', async () => {
  const mockClient = makeMockClient({ single: null });

  const result = await findNeighborhoodByAlias('   ', mockClient as any);

  assert.strictEqual(result, null);
  assert.deepStrictEqual(mockClient.calls, [], 'No debe llamar a .from() con un alias vacío.');
});

test('findNeighborhoodByPoint - rechaza coordenadas no finitas antes de consultar', async () => {
  const mockClient = makeMockClient();

  await assert.rejects(() => findNeighborhoodByPoint(NaN, -65.2, mockClient as any), ZonesServiceError);
  assert.deepStrictEqual(mockClient.calls, [], 'No debe llamar al RPC con coordenadas inválidas.');
});

test('findNeighborhoodByPoint - invoca el RPC neighborhood_for_point con lat/lon', async () => {
  const mockClient = makeMockClient({ rows: [{ id: 'n1', name: 'ZONA_MATE_DE_LUNA', group_id: 'g1' }] });

  const result = await findNeighborhoodByPoint(-26.82, -65.24, mockClient as any);

  assert.deepStrictEqual(mockClient.calls[0], { method: 'rpc', args: ['neighborhood_for_point', { lat: -26.82, lon: -65.24 }] });
  assert.deepStrictEqual(result, { id: 'n1', name: 'ZONA_MATE_DE_LUNA', group_id: 'g1' });
});

test('findNeighborhoodByPoint - devuelve null si ningún polígono contiene el punto', async () => {
  const mockClient = makeMockClient({ rows: [] });

  const result = await findNeighborhoodByPoint(0, 0, mockClient as any);

  assert.strictEqual(result, null);
});

test('findNeighborhoodByPoint - propaga errores del RPC como ZonesServiceError', async () => {
  const mockClient = makeMockClient({ error: { message: 'fallo simulado' } });

  await assert.rejects(() => findNeighborhoodByPoint(-26.82, -65.24, mockClient as any), ZonesServiceError);
});

// --- KAN-22: ST_Within + ST_DWithin (maxDistanceMeters opcional) ---

test('findNeighborhoodByPoint (KAN-22) - sin maxDistanceMeters, no lo incluye en los params del RPC (usa el DEFAULT de la función en la base)', async () => {
  const mockClient = makeMockClient({ rows: [] });

  await findNeighborhoodByPoint(-26.82, -65.24, mockClient as any);

  assert.deepStrictEqual(mockClient.calls[0], { method: 'rpc', args: ['neighborhood_for_point', { lat: -26.82, lon: -65.24 }] });
});

test('findNeighborhoodByPoint (KAN-22) - con maxDistanceMeters explícito, lo incluye en los params del RPC', async () => {
  const mockClient = makeMockClient({ rows: [{ id: 'n1', name: 'YERBA_BUENA', group_id: 'g1', match_type: 'nearby' }] });

  const result = await findNeighborhoodByPoint(-26.82, -65.24, mockClient as any, 300);

  assert.deepStrictEqual(mockClient.calls[0], { method: 'rpc', args: ['neighborhood_for_point', { lat: -26.82, lon: -65.24, max_distance_meters: 300 }] });
  assert.strictEqual(result?.id, 'n1');
});

// --- KAN-22: resolveNeighborhoodIdByText / resolvePropertyZoneId ---
// Mock table-aware: a diferencia de makeMockClient (una sola tabla implícita por test), acá
// getZoneKeywordIndex hace dos SELECT en paralelo (neighborhoods + neighborhood_aliases) que
// necesitan devolver datos distintos en el mismo test.
function makeTableAwareMockClient(tables: Record<string, { rows?: any[]; error?: any }>, rpc?: { rows?: any[]; error?: any }) {
  const calls: { method: string; table?: string; args: any[] }[] = [];
  return {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      const cfg = tables[table] || {};
      return {
        select: (...args: any[]) => {
          calls.push({ method: 'select', table, args });
          return Promise.resolve({ data: cfg.rows ?? [], error: cfg.error ?? null });
        }
      };
    },
    rpc: (fn: string, params: any) => {
      calls.push({ method: 'rpc', args: [fn, params] });
      return Promise.resolve({ data: rpc?.rows ?? [], error: rpc?.error ?? null });
    },
    calls
  };
}

test('resolveNeighborhoodIdByText - resuelve por el nombre de una zona contenido en el texto', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }, { id: 'n-norte', name: 'Barrio Norte' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolveNeighborhoodIdByText('busco depto 2 dorm en yerba buena con cochera', mockClient as any);

  assert.strictEqual(result, 'n-yb');
});

test('resolveNeighborhoodIdByText - resuelve por alias cuando el nombre canónico no aparece en el texto', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [{ alias: 'yb', neighborhood_id: 'n-yb', neighborhoods: { name: 'Yerba Buena' } }] }
  });

  const result = await resolveNeighborhoodIdByText('busco algo por yb urgente', mockClient as any);

  assert.strictEqual(result, 'n-yb');
});

test('resolveNeighborhoodIdByText - prioriza el keyword más largo/específico (evita que uno corto y genérico gane)', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-norte', name: 'Norte' }, { id: 'n-barrio-norte', name: 'Barrio Norte' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolveNeighborhoodIdByText('busco en barrio norte', mockClient as any);

  assert.strictEqual(result, 'n-barrio-norte', 'Debe preferir "barrio norte" (más específico) sobre "norte".');
});

test('resolveNeighborhoodIdByText (AC KAN-22) - Barrio Norte y Barrio Sur resuelven a ids distintos', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-norte', name: 'Barrio Norte' }, { id: 'n-sur', name: 'Barrio Sur' }] },
    neighborhood_aliases: { rows: [] }
  });

  const norte = await resolveNeighborhoodIdByText('busco en barrio norte', mockClient as any);
  const sur = await resolveNeighborhoodIdByText('busco en barrio sur', mockClient as any);

  assert.strictEqual(norte, 'n-norte');
  assert.strictEqual(sur, 'n-sur');
  assert.notStrictEqual(norte, sur, 'Barrio Norte y Barrio Sur deben resolver a zonas distintas.');
});

// --- KAN-92: resolveNeighborhoodByText expone también el nombre legible, no solo el id ---

test('resolveNeighborhoodByText (KAN-92) - devuelve id y nombre legible cuando resuelve por el nombre canónico', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolveNeighborhoodByText('busco depto en yerba buena', mockClient as any);

  assert.deepStrictEqual(result, { id: 'n-yb', name: 'Yerba Buena' });
});

test('resolveNeighborhoodByText (KAN-92) - devuelve el nombre de la zona real (no el alias) cuando resuelve por alias', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [{ alias: 'yb', neighborhood_id: 'n-yb', neighborhoods: { name: 'Yerba Buena' } }] }
  });

  const result = await resolveNeighborhoodByText('busco algo por yb urgente', mockClient as any);

  assert.deepStrictEqual(result, { id: 'n-yb', name: 'Yerba Buena' });
});

test('resolveNeighborhoodByText (KAN-92) - devuelve null si ningún keyword conocido aparece en el texto', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolveNeighborhoodByText('busco algo en marte', mockClient as any);

  assert.strictEqual(result, null);
});

test('resolveNeighborhoodByText (KAN-92) - un alias huérfano (sin join a neighborhoods resuelto) se ignora en vez de romper', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [] },
    // Simula un neighborhood_id de alias que no matchea ningún neighborhood real (borrado, FK
    // huérfana, etc.) — el join `neighborhoods(name)` de Supabase vendría null/undefined.
    neighborhood_aliases: { rows: [{ alias: 'yb', neighborhood_id: 'n-yb' }] }
  });

  const result = await resolveNeighborhoodByText('busco algo por yb urgente', mockClient as any);

  assert.strictEqual(result, null, 'Un alias sin nombre resuelto no debe generar una zona con nombre undefined.');
});

test('resolveNeighborhoodIdByText - devuelve null (no error) si ningún keyword conocido aparece en el texto', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolveNeighborhoodIdByText('busco algo en marte', mockClient as any);

  assert.strictEqual(result, null);
});

test('resolveNeighborhoodIdByText - texto vacío devuelve null sin consultar la base', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({ neighborhoods: { rows: [] }, neighborhood_aliases: { rows: [] } });

  const result = await resolveNeighborhoodIdByText('   ', mockClient as any);

  assert.strictEqual(result, null);
  assert.deepStrictEqual(mockClient.calls, [], 'No debe consultar la base con texto vacío.');
});

test('resolveNeighborhoodIdByText - cachea el índice de keywords entre llamadas (no repite las 2 queries)', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [] }
  });

  await resolveNeighborhoodIdByText('yerba buena', mockClient as any);
  await resolveNeighborhoodIdByText('otra busqueda en yerba buena', mockClient as any);

  const fromCalls = mockClient.calls.filter((c) => c.method === 'from');
  assert.strictEqual(fromCalls.length, 2, 'Las 2 tablas (neighborhoods/neighborhood_aliases) deben consultarse una sola vez gracias al cache.');
});

test('resolvePropertyZoneId - resuelve por punto cuando la propiedad tiene lat/lng válidas', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient(
    { neighborhoods: { rows: [] }, neighborhood_aliases: { rows: [] } },
    { rows: [{ id: 'n-punto', name: 'ZONA_POR_PUNTO', group_id: 'g1', match_type: 'contains' }] }
  );

  const result = await resolvePropertyZoneId(
    { latitude: -26.82, longitude: -65.24, address: 'Cualquier dirección', sheet_name: 'Ventas' },
    mockClient as any
  );

  assert.strictEqual(result, 'n-punto');
  assert.ok(mockClient.calls.some((c) => c.method === 'rpc'), 'Debe intentar resolver por punto primero.');
  assert.ok(!mockClient.calls.some((c) => c.method === 'from'), 'No debe caer al fallback de texto si el punto ya resolvió.');
});

test('resolvePropertyZoneId - sin coordenadas (o lat/lng en 0,0) cae directo al fallback de texto', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolvePropertyZoneId(
    { latitude: 0, longitude: 0, address: 'Yerba Buena 1500', sheet_name: 'Ventas' },
    mockClient as any
  );

  assert.strictEqual(result, 'n-yb');
  assert.ok(!mockClient.calls.some((c) => c.method === 'rpc'), 'lat/lng en (0,0) debe tratarse como "sin coordenadas", sin llamar al RPC espacial.');
});

// KAN-80: lat/lng null es el estado real de una propiedad cuyo geocoding falló (ver
// GeocodingService/syncPropertiesToDatabase) — no debe romper resolvePropertyZoneId ni intentar
// llamar al RPC espacial con coordenadas inválidas; debe excluirse del matching espacial y caer
// directo al fallback de texto, igual que "sin coordenadas".
test('resolvePropertyZoneId - lat/lng null (geocoding fallido) no rompe y cae al fallback de texto', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolvePropertyZoneId(
    { latitude: null, longitude: null, address: 'Yerba Buena 1500', sheet_name: 'Ventas' },
    mockClient as any
  );

  assert.strictEqual(result, 'n-yb');
  assert.ok(!mockClient.calls.some((c) => c.method === 'rpc'), 'lat/lng null (geocoding fallido) no debe llamar al RPC espacial.');
});

test('resolvePropertyZoneId - si el punto no resuelve ninguna zona, cae al fallback de texto', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient(
    { neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] }, neighborhood_aliases: { rows: [] } },
    { rows: [] } // RPC no encuentra nada (ni exacto ni cercano)
  );

  const result = await resolvePropertyZoneId(
    { latitude: -26.82, longitude: -65.24, address: 'Yerba Buena 1500', sheet_name: 'Ventas' },
    mockClient as any
  );

  assert.strictEqual(result, 'n-yb', 'Debe caer al fallback de texto cuando el punto no cae dentro ni cerca de ninguna zona.');
});

// --- Estados de zona (2026-08-11): resolveMultipleNeighborhoodsByText, soporte multi-zona OR ---

test('resolveMultipleNeighborhoodsByText - resuelve varias menciones a zonas distintas', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-lujan', name: 'Villa Lujan' }, { id: 'n-tafi', name: 'Tafi Viejo' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolveMultipleNeighborhoodsByText(['villa lujan', 'tafi viejo'], mockClient as any);

  assert.deepStrictEqual(
    result.map(r => r.id).sort(),
    ['n-lujan', 'n-tafi'],
    'Debe resolver ambas menciones, no solo la primera.'
  );
});

test('resolveMultipleNeighborhoodsByText - deduplica cuando dos menciones distintas resuelven a la misma zona', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [{ alias: 'yb', neighborhood_id: 'n-yb', neighborhoods: { name: 'Yerba Buena' } }] }
  });

  const result = await resolveMultipleNeighborhoodsByText(['yerba buena', 'yb'], mockClient as any);

  assert.strictEqual(result.length, 1, 'Dos menciones que resuelven a la misma zona deben aparecer una sola vez.');
  assert.strictEqual(result[0].id, 'n-yb');
});

test('resolveMultipleNeighborhoodsByText - una mención sin match se omite sin romper la resolución de las demás', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({
    neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] },
    neighborhood_aliases: { rows: [] }
  });

  const result = await resolveMultipleNeighborhoodsByText(['yerba buena', 'barrio inexistente xyz'], mockClient as any);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'n-yb');
});

test('resolveMultipleNeighborhoodsByText - array vacío de menciones devuelve array vacío', async () => {
  __clearZoneKeywordCacheForTests();
  const mockClient = makeTableAwareMockClient({ neighborhoods: { rows: [{ id: 'n-yb', name: 'Yerba Buena' }] }, neighborhood_aliases: { rows: [] } });

  const result = await resolveMultipleNeighborhoodsByText([], mockClient as any);

  assert.deepStrictEqual(result, []);
});
