import test from 'node:test';
import assert from 'node:assert';
import * as express from 'express';
import { createSearch } from '../src/controllers/searchController';
import * as aiService from '../src/services/ai';
import * as searchSegmentProcessorService from '../src/services/searchSegmentProcessor';
import * as planLimitsService from '../src/services/planLimits';

// Fase 1 pre-lanzamiento: cuota mensual de búsquedas del plan (10/mes en FREE, ver
// src/config/planLimits.ts). createSearch no expone un shape fácil de invocar vía HTTP real (no hay
// harness de supertest en este repo, ver tests/errorMessageLeak.test.ts), así que se llama
// directamente con req/res fake, mismo criterio que el resto de los controller tests de este repo
// que mockean los servicios externos vía t.mock.method (ver tests/searchSegmentProcessor.test.ts).

function makeReq(text: string): express.Request {
  return {
    body: { text },
    // tenantId/supabaseClient los agrega tenantAuthMiddleware en producción — acá se simulan directo.
    tenantId: 'tenant-1',
    supabaseClient: {}
  } as any;
}

function makeRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.jsonBody = undefined;
  res.json = (body: any) => { res.jsonBody = body; return res; };
  return res;
}

test('createSearch - cuota mensual ya agotada: 403 inmediato sin llamar a segmentSearchRequests ni procesar nada', async (t) => {
  t.mock.method(planLimitsService, 'getTenantPlanLimits', async () => ({ maxProperties: 100, maxSearchesPerMonth: 10 }));
  t.mock.method(planLimitsService, 'countTenantSearchesThisMonth', async () => 10);
  const segmentMock = t.mock.method(aiService, 'segmentSearchRequests', async () => ['busco depto en el centro']);
  const processMock = t.mock.method(searchSegmentProcessorService, 'processSingleSearchSegment', async () => ({ success: true, raw_text: 'x' }));

  const req = makeReq('busco depto en el centro de la ciudad');
  const res = makeRes();

  await createSearch(req, res as any);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.jsonBody.code, 'SEARCH_QUOTA_EXCEEDED');
  assert.strictEqual(segmentMock.mock.callCount(), 0, 'No debe segmentar (ni gastar la llamada a IA de Agente 0) si ya no queda cuota.');
  assert.strictEqual(processMock.mock.callCount(), 0);
});

test('createSearch - un mensaje segmentado en más sub-búsquedas de las que quedan de cuota procesa solo las que entran y marca el resto como cuota agotada', async (t) => {
  t.mock.method(planLimitsService, 'getTenantPlanLimits', async () => ({ maxProperties: 100, maxSearchesPerMonth: 10 }));
  t.mock.method(planLimitsService, 'countTenantSearchesThisMonth', async () => 9); // queda 1 de cupo
  t.mock.method(aiService, 'segmentSearchRequests', async () => ['segmento uno', 'segmento dos']);
  const processMock = t.mock.method(searchSegmentProcessorService, 'processSingleSearchSegment', async (tenantId: string, supabase: any, segmentText: string) => ({
    success: true,
    raw_text: segmentText
  }));

  const req = makeReq('busco depto en el centro y también una casa en las afueras');
  const res = makeRes();

  await createSearch(req, res as any);

  assert.strictEqual(res.statusCode, 200, 'Al menos un segmento tuvo éxito, debe responder 2xx.');
  assert.strictEqual(processMock.mock.callCount(), 1, 'Solo debe procesar 1 segmento (el único cupo que quedaba).');
  assert.strictEqual(res.jsonBody.searches.length, 2);
  assert.strictEqual(res.jsonBody.searches[0].success, true);
  assert.strictEqual(res.jsonBody.searches[0].raw_text, 'segmento uno');
  assert.strictEqual(res.jsonBody.searches[1].success, false);
  assert.strictEqual(res.jsonBody.searches[1].code, 'SEARCH_QUOTA_EXCEEDED');
  assert.strictEqual(res.jsonBody.searches[1].raw_text, 'segmento dos');
});

test('createSearch - con cupo disponible, procesa todos los segmentos con normalidad (200, sin marcas de cuota)', async (t) => {
  t.mock.method(planLimitsService, 'getTenantPlanLimits', async () => ({ maxProperties: 100, maxSearchesPerMonth: 10 }));
  t.mock.method(planLimitsService, 'countTenantSearchesThisMonth', async () => 0);
  t.mock.method(aiService, 'segmentSearchRequests', async () => ['busco depto en el centro']);
  t.mock.method(searchSegmentProcessorService, 'processSingleSearchSegment', async () => ({ success: true, raw_text: 'busco depto en el centro' }));

  const req = makeReq('busco depto en el centro de la ciudad');
  const res = makeRes();

  await createSearch(req, res as any);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.jsonBody.success, true);
  assert.strictEqual(res.jsonBody.searches.length, 1);
  assert.strictEqual(res.jsonBody.searches[0].code, undefined);
});

test('createSearch - si todos los segmentos procesados fallan y el resto queda sin cupo, responde 403 (no 500)', async (t) => {
  t.mock.method(planLimitsService, 'getTenantPlanLimits', async () => ({ maxProperties: 100, maxSearchesPerMonth: 10 }));
  t.mock.method(planLimitsService, 'countTenantSearchesThisMonth', async () => 9); // queda 1 de cupo
  t.mock.method(aiService, 'segmentSearchRequests', async () => ['segmento uno', 'segmento dos']);
  t.mock.method(searchSegmentProcessorService, 'processSingleSearchSegment', async () => ({
    success: false,
    raw_text: 'segmento uno',
    error: 'No pudimos clasificar el texto como un pedido de propiedad.'
  }));

  const req = makeReq('un mensaje raro que no clasifica bien');
  const res = makeRes();

  await createSearch(req, res as any);

  assert.strictEqual(res.statusCode, 403, 'Sin timeouts de IA de por medio, allFailed + algún segmento sobre cupo debe dar 403, no 500 genérico.');
  assert.strictEqual(res.jsonBody.success, false);
});
