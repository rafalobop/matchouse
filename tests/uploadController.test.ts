import test from 'node:test';
import assert from 'node:assert';
import * as express from 'express';
// Side-effect: activa la augmentation de tipos de @types/multer sobre express.Request#file — sin
// esto, TypeScript no reconoce `req.file` acá porque este archivo no importa `multer` en runtime
// (solo lo hace uploadRoutes.ts, que no forma parte de este árbol de compilación de test).
import 'multer';
import * as xlsx from 'xlsx';
import { uploadCatalog, confirmMapping } from '../src/controllers/uploadController';
import * as excelService from '../src/services/excel';
import * as excelMappingService from '../src/services/excelMapping';
import * as planLimitsService from '../src/services/planLimits';
import { computeHeaderSignature } from '../src/utils/excelHeaderMatcher';

// Fase 1 pre-lanzamiento: cap de cartera del plan (100 en FREE, ver src/config/planLimits.ts)
// aplicado en uploadController.ts (la implementación real y montada de POST /api/upload —
// src/routes/upload.ts es un archivo huérfano que quedó sin montar tras el split de src/index.ts,
// no se toca acá). Mismo criterio de mock directo del controller que tests/searchController.test.ts.

function buildXlsxBuffer(sheetName: string, rows: any[][]): Buffer {
  const worksheet = xlsx.utils.aoa_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function buildCatalogBuffer(rowCount: number): Buffer {
  const headerRow = ['Domicilio', 'Precio'];
  const dataRows = Array.from({ length: rowCount }, (_, i) => [`Calle Falsa ${i + 1}`, 100000 + i]);
  return buildXlsxBuffer('Ventas', [headerRow, ...dataRows]);
}

function makeReq(buffer: Buffer, extraBody: Record<string, any> = {}): express.Request {
  return {
    tenantId: 'tenant-1',
    supabaseClient: {},
    file: { buffer } as any,
    body: extraBody
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

// Mockea resolveColumnMapping para que siempre resuelva "ready" sin depender de Supabase
// (mapeo guardado/heurística/IA, ya cubierto por tests/excelMapping.test.ts) y toColumnMapRecord
// para no tener que replicar el shape completo de ResolvedFieldMapping[] acá.
function mockReadyMapping(t: any) {
  t.mock.method(excelMappingService, 'resolveColumnMapping', async (_tenantId: string, headers: string[]) => ({
    status: 'ready',
    source: 'stored',
    headerSignature: computeHeaderSignature(headers),
    fields: []
  }));
  // Shape real de toColumnMapRecord: Record<ExcelMappingField, header> — 'domicilio'/'precio' son
  // los ExcelMappingField (español, ver utils/excelHeaderMatcher.ts), no nombres de campo en inglés.
  // Los valores son el header EXACTO (ya en minúsculas, como lo deja peekExcelHeaders) de este Excel.
  t.mock.method(excelMappingService, 'toColumnMapRecord', () => ({ domicilio: 'domicilio', precio: 'precio' }));
}

test('uploadCatalog - un Excel con más filas de las que permite el plan responde 400 sin sincronizar la base', async (t) => {
  mockReadyMapping(t);
  t.mock.method(planLimitsService, 'getTenantPlanLimits', async () => ({ maxProperties: 2, maxSearchesPerMonth: 10 }));
  const syncMock = t.mock.method(excelService, 'syncPropertiesToDatabase', async () => {});

  const req = makeReq(buildCatalogBuffer(3));
  const res = makeRes();

  await uploadCatalog(req, res as any);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.jsonBody.error, /3 propiedades.*hasta 2/);
  assert.strictEqual(syncMock.mock.callCount(), 0, 'No debe tocar la base si el archivo excede el límite del plan.');
});

test('uploadCatalog - un Excel dentro del límite del plan sincroniza normalmente', async (t) => {
  mockReadyMapping(t);
  t.mock.method(planLimitsService, 'getTenantPlanLimits', async () => ({ maxProperties: 100, maxSearchesPerMonth: 10 }));
  const syncMock = t.mock.method(excelService, 'syncPropertiesToDatabase', async () => ({ geocodeFailures: [] }));

  const req = makeReq(buildCatalogBuffer(3));
  const res = makeRes();

  await uploadCatalog(req, res as any);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.jsonBody.success, true);
  assert.strictEqual(res.jsonBody.count, 3);
  assert.strictEqual(res.jsonBody.loaded.length, 3);
  assert.strictEqual(res.jsonBody.failed.length, 0);
  assert.strictEqual(syncMock.mock.callCount(), 1);
});

test('confirmMapping - mismo cap de cartera que uploadCatalog: 400 sin sincronizar si excede el límite', async (t) => {
  mockReadyMapping(t);
  t.mock.method(planLimitsService, 'getTenantPlanLimits', async () => ({ maxProperties: 1, maxSearchesPerMonth: 10 }));
  const syncMock = t.mock.method(excelService, 'syncPropertiesToDatabase', async () => {});

  // Body de mappings vacío a propósito: sin una entrada para "Ventas", confirmMapping cae en el
  // mismo fallback a resolveColumnMapping (mockeado arriba) que usa una hoja ya resuelta sola en
  // la corrida anterior — evita mockear también confirmColumnMapping, no relevante para este test.
  const buffer = buildCatalogBuffer(2);
  const req = makeReq(buffer, { mappings: JSON.stringify({}) });
  const res = makeRes();

  await confirmMapping(req, res as any);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.jsonBody.error, /2 propiedades.*hasta 1/);
  assert.strictEqual(syncMock.mock.callCount(), 0);
});
