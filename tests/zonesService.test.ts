import test from 'node:test';
import assert from 'node:assert';
import {
  listNeighborhoodGroups,
  listNeighborhoods,
  findNeighborhoodByAlias,
  findNeighborhoodByPoint,
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
