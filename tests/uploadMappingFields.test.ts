import test from 'node:test';
import assert from 'node:assert';
import uploadRouter from '../src/routes/upload';
import { startTestServer } from './helpers/testServer';
import { EXCEL_MAPPING_FIELDS, REQUIRED_EXCEL_MAPPING_FIELDS, EXCEL_MAPPING_FIELDS_VERSION } from '../src/utils/excelHeaderMatcher';

// KAN-215: GET /api/upload/mapping-fields expone el contrato compartido de MAPPING_FIELDS —
// el frontend lo consume en vez de hardcodear su propia copia (ver
// docs/evolucion_proyecto/mapping_fields_contract.md). Público, sin tenantAuthMiddleware.

test('KAN-215 - GET /api/upload/mapping-fields responde 200 sin sesión de tenant', async () => {
  const server = await startTestServer(uploadRouter);
  try {
    const res = await fetch(`${server.baseUrl}/api/upload/mapping-fields`);
    assert.strictEqual(res.status, 200);
  } finally {
    await server.close();
  }
});

test('KAN-215 - GET /api/upload/mapping-fields devuelve version/fields/required en sync con excelHeaderMatcher.ts', async () => {
  const server = await startTestServer(uploadRouter);
  try {
    const res = await fetch(`${server.baseUrl}/api/upload/mapping-fields`);
    const body = await res.json() as { version: number; fields: string[]; required: string[] };

    assert.strictEqual(body.version, EXCEL_MAPPING_FIELDS_VERSION);
    assert.deepStrictEqual(body.fields, EXCEL_MAPPING_FIELDS);
    assert.deepStrictEqual(body.required, REQUIRED_EXCEL_MAPPING_FIELDS);
  } finally {
    await server.close();
  }
});

test('KAN-215 - GET /api/upload/mapping-fields incluye los campos requeridos dentro de la lista completa', async () => {
  const server = await startTestServer(uploadRouter);
  try {
    const res = await fetch(`${server.baseUrl}/api/upload/mapping-fields`);
    const body = await res.json() as { fields: string[]; required: string[] };

    for (const requiredField of body.required) {
      assert.ok(body.fields.includes(requiredField), `${requiredField} debe estar en fields`);
    }
  } finally {
    await server.close();
  }
});
