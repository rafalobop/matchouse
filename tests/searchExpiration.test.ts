import test from 'node:test';
import assert from 'node:assert';
import {
  runSearchExpiration,
  startSearchExpirationService,
  stopSearchExpirationService
} from '../src/services/searchExpiration';

// Mock minimo de un query builder de Supabase encadenable (update().eq().lt().select()),
// mismo estilo de mock usado en otros tests de este proyecto que ejercitan queries encadenadas.
function makeMockClient(options: { rows?: { id: string }[]; error?: any } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const builder: any = {
    update: (...args: any[]) => { calls.push({ method: 'update', args }); return builder; },
    eq: (...args: any[]) => { calls.push({ method: 'eq', args }); return builder; },
    lt: (...args: any[]) => { calls.push({ method: 'lt', args }); return builder; },
    select: (...args: any[]) => {
      calls.push({ method: 'select', args });
      return Promise.resolve({ data: options.rows ?? [], error: options.error ?? null });
    }
  };
  return {
    from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder; },
    calls
  };
}

test('SearchExpiration - expone las funciones esperadas', () => {
  assert.strictEqual(typeof runSearchExpiration, 'function');
  assert.strictEqual(typeof startSearchExpirationService, 'function');
  assert.strictEqual(typeof stopSearchExpirationService, 'function');
});

test('SearchExpiration - runSearchExpiration opera sobre la tabla y filtros correctos', async () => {
  const mockClient = makeMockClient({ rows: [{ id: 'search-1' }] });

  await runSearchExpiration(mockClient as any);

  assert.deepStrictEqual(mockClient.calls[0], { method: 'from', args: ['active_searches'] });
  assert.deepStrictEqual(mockClient.calls[1], { method: 'update', args: [{ status: 'expired' }] }, 'Debe persistir "expired" en minúscula (el CHECK constraint real no acepta "EXPIRED").');
  assert.deepStrictEqual(mockClient.calls[2], { method: 'eq', args: ['status', 'active'] }, 'Solo debe tocar búsquedas actualmente "active" (las "matched"/"cancelled" quedan afuera por este filtro).');
  assert.strictEqual(mockClient.calls[3].method, 'lt');
  assert.strictEqual(mockClient.calls[3].args[0], 'expires_at');
});

test('SearchExpiration - runSearchExpiration devuelve los IDs marcados como expired', async () => {
  const mockClient = makeMockClient({ rows: [{ id: 'search-1' }, { id: 'search-2' }] });

  const result = await runSearchExpiration(mockClient as any);

  assert.deepStrictEqual(result, ['search-1', 'search-2']);
});

test('SearchExpiration - runSearchExpiration devuelve array vacío si no hay búsquedas vencidas', async () => {
  const mockClient = makeMockClient({ rows: [] });

  const result = await runSearchExpiration(mockClient as any);

  assert.deepStrictEqual(result, []);
});

test('SearchExpiration - runSearchExpiration propaga errores del cliente', async () => {
  const mockClient = makeMockClient({ error: { message: 'fallo simulado' } });

  await assert.rejects(() => runSearchExpiration(mockClient as any));
});

test('SearchExpiration - start/stop no lanzan y dejan un timer detenible', () => {
  startSearchExpirationService();
  stopSearchExpirationService();
  assert.ok(true, 'startSearchExpirationService/stopSearchExpirationService deben poder llamarse sin lanzar.');
});
