import test from 'node:test';
import assert from 'node:assert';
import { recordLlmCall, getLlmCostByTenantForMonth, getTotalLlmCostForMonth } from '../src/services/llmCallsRepository';
import { createFakeSupabaseClient, chainableResult } from './helpers/fakeSupabaseClient';

test('BE-04: recordLlmCall inserta una fila en llm_calls con los campos mapeados a snake_case', async () => {
  let capturedTable: string | undefined;
  let capturedInsert: any;
  const client = createFakeSupabaseClient((table: string) => {
    capturedTable = table;
    return {
      insert: (payload: any) => {
        capturedInsert = payload;
        return chainableResult({ data: null, error: null });
      }
    };
  });

  await recordLlmCall(client, {
    operation: 'extract-intent',
    model: 'gemini-2.5-flash-lite',
    promptVersion: 'agent1-text-input-v1',
    tokensIn: 100,
    tokensOut: 20,
    latencyMs: 350,
    costUsd: 0.000018,
    fallbackUsed: false,
    schemaValid: true,
    tenantId: 'tenant-1',
    searchId: null
  });

  assert.strictEqual(capturedTable, 'llm_calls');
  assert.deepStrictEqual(capturedInsert, {
    operation: 'extract-intent',
    model: 'gemini-2.5-flash-lite',
    prompt_version: 'agent1-text-input-v1',
    tokens_in: 100,
    tokens_out: 20,
    latency_ms: 350,
    cost_usd: 0.000018,
    fallback_used: false,
    schema_valid: true,
    tenant_id: 'tenant-1',
    search_id: null
  });
});

test('BE-04: recordLlmCall nunca lanza, incluso si el insert falla (no debe afectar la extracción ya resuelta)', async () => {
  const client = createFakeSupabaseClient(() => ({
    insert: () => chainableResult({ data: null, error: { message: 'boom' } })
  }));

  await assert.doesNotReject(() => recordLlmCall(client, {
    operation: 'extract-intent',
    model: 'gemini-2.5-flash-lite',
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 10,
    costUsd: 0,
    fallbackUsed: false,
    schemaValid: false
  }));
});

test('BE-04: recordLlmCall usa null por default para promptVersion/tenantId/searchId ausentes', async () => {
  let capturedInsert: any;
  const client = createFakeSupabaseClient(() => ({
    insert: (payload: any) => {
      capturedInsert = payload;
      return chainableResult({ data: null, error: null });
    }
  }));

  await recordLlmCall(client, {
    operation: 'segment',
    model: 'gpt-4o-mini',
    tokensIn: 5,
    tokensOut: 1,
    latencyMs: 20,
    costUsd: 0,
    fallbackUsed: true,
    schemaValid: true
  });

  assert.strictEqual(capturedInsert.prompt_version, null);
  assert.strictEqual(capturedInsert.tenant_id, null);
  assert.strictEqual(capturedInsert.search_id, null);
});

test('BE-04: getLlmCostByTenantForMonth suma cost_usd de las filas del tenant filtradas por el rango del mes', async () => {
  let capturedFilters: { tenantId?: string; gte?: string; lt?: string } = {};
  const client = createFakeSupabaseClient(() => {
    const handler: any = {
      select: () => handler,
      eq: (_col: string, value: string) => { capturedFilters.tenantId = value; return handler; },
      gte: (_col: string, value: string) => { capturedFilters.gte = value; return handler; },
      lt: (_col: string, value: string) => { capturedFilters.lt = value; return handler; },
      then: (resolve: any) => Promise.resolve({
        data: [{ cost_usd: 0.01 }, { cost_usd: 0.02 }, { cost_usd: 0.005 }],
        error: null
      }).then(resolve)
    };
    return handler;
  });

  const total = await getLlmCostByTenantForMonth(client, 'tenant-1', 2026, 10);

  assert.strictEqual(capturedFilters.tenantId, 'tenant-1');
  assert.strictEqual(capturedFilters.gte, new Date(Date.UTC(2026, 9, 1)).toISOString());
  assert.strictEqual(capturedFilters.lt, new Date(Date.UTC(2026, 10, 1)).toISOString());
  assert.ok(Math.abs(total - 0.035) < 1e-9, `costo total inesperado: ${total}`);
});

test('BE-04: getLlmCostByTenantForMonth devuelve 0 sin filas y propaga errores reales de la query', async () => {
  const emptyClient = createFakeSupabaseClient(() => chainableResult({ data: [], error: null }));
  const total = await getLlmCostByTenantForMonth(emptyClient, 'tenant-2', 2026, 12);
  assert.strictEqual(total, 0);

  const erroringClient = createFakeSupabaseClient(() => chainableResult({ data: null, error: { message: 'db down' } }));
  await assert.rejects(() => getLlmCostByTenantForMonth(erroringClient, 'tenant-2', 2026, 12));
});

test('BE-45: getTotalLlmCostForMonth suma cost_usd de TODOS los tenants del rango del mes, sin filtrar por tenant_id', async () => {
  let capturedFilters: { eqCalled: boolean; gte?: string; lt?: string } = { eqCalled: false };
  const client = createFakeSupabaseClient(() => {
    const handler: any = {
      select: () => handler,
      eq: () => { capturedFilters.eqCalled = true; return handler; },
      gte: (_col: string, value: string) => { capturedFilters.gte = value; return handler; },
      lt: (_col: string, value: string) => { capturedFilters.lt = value; return handler; },
      then: (resolve: any) => Promise.resolve({
        data: [{ cost_usd: 0.01 }, { cost_usd: 0.02 }, { cost_usd: 0.005 }],
        error: null
      }).then(resolve)
    };
    return handler;
  });

  const total = await getTotalLlmCostForMonth(client, 2026, 11);

  assert.strictEqual(capturedFilters.eqCalled, false, 'No debe filtrar por tenant_id (agregado de toda la plataforma).');
  assert.strictEqual(capturedFilters.gte, new Date(Date.UTC(2026, 10, 1)).toISOString());
  assert.strictEqual(capturedFilters.lt, new Date(Date.UTC(2026, 11, 1)).toISOString());
  assert.ok(Math.abs(total - 0.035) < 1e-9, `costo total inesperado: ${total}`);
});

test('BE-45: getTotalLlmCostForMonth devuelve 0 sin filas y propaga errores reales de la query', async () => {
  const emptyClient = createFakeSupabaseClient(() => chainableResult({ data: [], error: null }));
  const total = await getTotalLlmCostForMonth(emptyClient, 2026, 12);
  assert.strictEqual(total, 0);

  const erroringClient = createFakeSupabaseClient(() => chainableResult({ data: null, error: { message: 'db down' } }));
  await assert.rejects(() => getTotalLlmCostForMonth(erroringClient, 2026, 12));
});

test('BE-45: getTotalLlmCostForMonth maneja diciembre (cruce de año) igual que getLlmCostByTenantForMonth', async () => {
  let capturedFilters: { gte?: string; lt?: string } = {};
  const client = createFakeSupabaseClient(() => {
    const handler: any = {
      select: () => handler,
      gte: (_col: string, value: string) => { capturedFilters.gte = value; return handler; },
      lt: (_col: string, value: string) => { capturedFilters.lt = value; return handler; },
      then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve)
    };
    return handler;
  });

  await getTotalLlmCostForMonth(client, 2026, 12);

  assert.strictEqual(capturedFilters.gte, new Date(Date.UTC(2026, 11, 1)).toISOString());
  assert.strictEqual(capturedFilters.lt, new Date(Date.UTC(2027, 0, 1)).toISOString());
});
