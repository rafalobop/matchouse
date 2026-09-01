import test from 'node:test';
import assert from 'node:assert';
import {
  findReengagementCandidates,
  runReengagementMessages,
  startReengagementService,
  stopReengagementService,
  ReengagementDeps
} from '../src/services/reengagement';

// Mock de un cliente Supabase que sabe responder a las dos tablas reales que toca este servicio
// (active_searches para leer/marcar, blind_matches para descartar las ya matcheadas), mismo estilo
// de mock de query builder encadenable usado en searchExpiration.test.ts/webPush.test.ts. El chain
// de `select().eq().eq()` es "thenable" (expone `.then`) para poder resolverse sin importar cuántos
// `.eq()` intermedios se encadenen.
function makeMockClient(options: {
  expiredRows?: any[];
  expiredError?: any;
  blindMatchRows?: any[];
  blindMatchError?: any;
  updateError?: any;
} = {}) {
  const calls: any[] = [];
  return {
    calls,
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });

      if (table === 'active_searches') {
        return {
          select: (...args: any[]) => {
            calls.push({ method: 'select', args, table: 'active_searches' });
            const chain: any = {
              eq: (...eqArgs: any[]) => {
                calls.push({ method: 'eq', args: eqArgs, table: 'active_searches(select)' });
                return chain;
              },
              then: (resolve: any) => resolve({ data: options.expiredRows ?? [], error: options.expiredError ?? null })
            };
            return chain;
          },
          update: (...args: any[]) => {
            calls.push({ method: 'update', args, table: 'active_searches' });
            return {
              eq: (...eqArgs: any[]) => {
                calls.push({ method: 'eq', args: eqArgs, table: 'active_searches(update)' });
                return Promise.resolve({ error: options.updateError ?? null });
              }
            };
          }
        };
      }

      if (table === 'blind_matches') {
        return {
          select: (...args: any[]) => {
            calls.push({ method: 'select', args, table: 'blind_matches' });
            return {
              in: (...inArgs: any[]) => {
                calls.push({ method: 'in', args: inArgs, table: 'blind_matches' });
                return Promise.resolve({ data: options.blindMatchRows ?? [], error: options.blindMatchError ?? null });
              }
            };
          }
        };
      }

      throw new Error(`tabla inesperada en el mock: ${table}`);
    }
  };
}

function makeDeps(overrides: Partial<ReengagementDeps> = {}): { deps: ReengagementDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      hasActivePush: async (tenantId: string) => { calls.push(`hasActivePush:${tenantId}`); return false; },
      sendPush: async (tenantId: string) => { calls.push(`sendPush:${tenantId}`); return true; },
      sendEmailFallback: async (tenantId: string) => { calls.push(`sendEmailFallback:${tenantId}`); return true; },
      ...overrides
    }
  };
}

test('reengagement - expone las funciones esperadas', () => {
  assert.strictEqual(typeof findReengagementCandidates, 'function');
  assert.strictEqual(typeof runReengagementMessages, 'function');
  assert.strictEqual(typeof startReengagementService, 'function');
  assert.strictEqual(typeof stopReengagementService, 'function');
});

test('findReengagementCandidates - filtra por status=expired y reengagement_sent=false', async () => {
  const mockClient = makeMockClient({ expiredRows: [], blindMatchRows: [] });

  await findReengagementCandidates(mockClient as any);

  assert.deepStrictEqual(mockClient.calls[0], { method: 'from', args: ['active_searches'] });
  assert.deepStrictEqual(mockClient.calls[2], { method: 'eq', args: ['status', 'expired'], table: 'active_searches(select)' });
  assert.deepStrictEqual(mockClient.calls[3], { method: 'eq', args: ['reengagement_sent', false], table: 'active_searches(select)' });
});

test('findReengagementCandidates - descarta las búsquedas que ya tienen un match en blind_matches', async () => {
  const mockClient = makeMockClient({
    expiredRows: [
      { id: 'search-1', tenant_id: 'tenant-a', raw_text: 'Busco depto' },
      { id: 'search-2', tenant_id: 'tenant-b', raw_text: 'Busco casa' }
    ],
    blindMatchRows: [{ search_id: 'search-1' }]
  });

  const candidates = await findReengagementCandidates(mockClient as any);

  assert.deepStrictEqual(candidates.map(c => c.id), ['search-2']);
});

test('findReengagementCandidates - sin búsquedas expiradas pendientes, no consulta blind_matches', async () => {
  const mockClient = makeMockClient({ expiredRows: [] });

  const candidates = await findReengagementCandidates(mockClient as any);

  assert.deepStrictEqual(candidates, []);
  assert.ok(!mockClient.calls.some((c: any) => c.args?.[0] === 'blind_matches'), 'No debe consultar blind_matches si no hay candidatas.');
});

test('findReengagementCandidates - propaga errores de active_searches', async () => {
  const mockClient = makeMockClient({ expiredError: { message: 'fallo simulado' } });

  await assert.rejects(() => findReengagementCandidates(mockClient as any));
});

test('findReengagementCandidates - propaga errores de blind_matches', async () => {
  const mockClient = makeMockClient({
    expiredRows: [{ id: 'search-1', tenant_id: 'tenant-a', raw_text: 'Busco depto' }],
    blindMatchError: { message: 'fallo simulado' }
  });

  await assert.rejects(() => findReengagementCandidates(mockClient as any));
});

test('runReengagementMessages (KAN-58 AC2) - con push activo, envía push y no el email', async () => {
  const mockClient = makeMockClient({
    expiredRows: [{ id: 'search-1', tenant_id: 'tenant-a', raw_text: 'Busco depto' }],
    blindMatchRows: []
  });
  const { deps, calls } = makeDeps({ hasActivePush: async () => true });

  const summary = await runReengagementMessages(mockClient as any, deps);

  assert.deepStrictEqual(summary, { processed: 1, sent: 1, failed: 0 });
  assert.ok(calls.includes('sendPush:tenant-a'));
  assert.ok(!calls.includes('sendEmailFallback:tenant-a'));
});

test('runReengagementMessages (KAN-58 AC2) - sin push activo, envía el email de respaldo', async () => {
  const mockClient = makeMockClient({
    expiredRows: [{ id: 'search-1', tenant_id: 'tenant-a', raw_text: 'Busco depto' }],
    blindMatchRows: []
  });
  const { deps, calls } = makeDeps({ hasActivePush: async () => false });

  const summary = await runReengagementMessages(mockClient as any, deps);

  assert.deepStrictEqual(summary, { processed: 1, sent: 1, failed: 0 });
  assert.ok(calls.includes('sendEmailFallback:tenant-a'));
  assert.ok(!calls.includes('sendPush:tenant-a'));
});

test('runReengagementMessages (KAN-58 AC3) - marca reengagement_sent=true tras un envío exitoso', async () => {
  const mockClient = makeMockClient({
    expiredRows: [{ id: 'search-1', tenant_id: 'tenant-a', raw_text: 'Busco depto' }],
    blindMatchRows: []
  });
  const { deps } = makeDeps();

  await runReengagementMessages(mockClient as any, deps);

  const updateCall = mockClient.calls.find((c: any) => c.method === 'update');
  assert.deepStrictEqual(updateCall.args, [{ reengagement_sent: true }]);
});

test('runReengagementMessages (KAN-58 AC3) - un fallo de envío no marca el flag, para no perder el aviso', async () => {
  const mockClient = makeMockClient({
    expiredRows: [{ id: 'search-1', tenant_id: 'tenant-a', raw_text: 'Busco depto' }],
    blindMatchRows: []
  });
  const { deps } = makeDeps({
    hasActivePush: async () => false,
    sendEmailFallback: async () => false
  });

  const summary = await runReengagementMessages(mockClient as any, deps);

  assert.deepStrictEqual(summary, { processed: 1, sent: 0, failed: 1 });
  assert.ok(!mockClient.calls.some((c: any) => c.method === 'update'), 'No debe llamar a update() si el envío falló.');
});

test('runReengagementMessages - procesa varias candidatas de forma independiente (una falla, la otra no)', async () => {
  const mockClient = makeMockClient({
    expiredRows: [
      { id: 'search-1', tenant_id: 'tenant-a', raw_text: 'Busco depto' },
      { id: 'search-2', tenant_id: 'tenant-b', raw_text: 'Busco casa' }
    ],
    blindMatchRows: []
  });
  const { deps } = makeDeps({
    hasActivePush: async () => false,
    sendEmailFallback: async (tenantId: string) => tenantId !== 'tenant-b'
  });

  const summary = await runReengagementMessages(mockClient as any, deps);

  assert.deepStrictEqual(summary, { processed: 2, sent: 1, failed: 1 });
});

test('runReengagementMessages - sin candidatas, no llama a ningún deps de envío', async () => {
  const mockClient = makeMockClient({ expiredRows: [] });
  const { deps, calls } = makeDeps();

  const summary = await runReengagementMessages(mockClient as any, deps);

  assert.deepStrictEqual(summary, { processed: 0, sent: 0, failed: 0 });
  assert.deepStrictEqual(calls, []);
});

test('reengagement - start/stop no lanzan y dejan un timer detenible', () => {
  startReengagementService();
  stopReengagementService();
  assert.ok(true, 'startReengagementService/stopReengagementService deben poder llamarse sin lanzar.');
});
