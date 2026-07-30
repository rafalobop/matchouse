import test from 'node:test';
import assert from 'node:assert';
import * as xlsx from 'xlsx';
import { processExcelBuffer, syncPropertiesToDatabase, Property } from '../src/services/excel';

// Mock mínimo del builder encadenable de Supabase, mismo patrón que tests/searchExpiration.test.ts.
// `selectResult` controla la respuesta del fetch inicial (paso 1); `mutationResult` controla
// la respuesta de upsert/delete (paso 5).
function buildMockSupabaseClient(options: {
  selectResult: { data: any[] | null; error: any };
  mutationResult?: { error: any };
}) {
  const mutationResult = options.mutationResult ?? { error: null };
  return {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve(options.selectResult)
      }),
      upsert: () => Promise.resolve(mutationResult),
      delete: () => ({
        in: () => ({
          eq: () => Promise.resolve(mutationResult)
        })
      })
    })
  } as any;
}

function buildSampleProperty(overrides: Partial<Property> = {}): Property {
  return {
    address: 'Calle Falsa 123',
    price: 100000,
    currency: 'USD',
    bedrooms: 2,
    property_type: 'departamento',
    operation: 'venta',
    sheet_name: 'Hoja1',
    ...overrides
  } as Property;
}

test('Excel Service - Debería retornar catálogo vacío o lanzar error para buffers sin datos', () => {
  assert.strictEqual(typeof processExcelBuffer, 'function', 'processExcelBuffer es una función.');

  const emptyBuffer = Buffer.alloc(0);
  try {
    const result = processExcelBuffer(emptyBuffer);
    assert.ok(Array.isArray(result.properties), 'properties debe ser un arreglo.');
    assert.strictEqual(result.properties.length, 0, 'El catálogo resultante debe ser vacío.');
    assert.ok(Array.isArray(result.priceParseErrors), 'priceParseErrors debe ser un arreglo.');
    assert.strictEqual(result.priceParseErrors.length, 0, 'No debe haber errores de precio sin filas.');
  } catch (error) {
    assert.ok(error instanceof Error, 'Si lanza error, debe ser un error válido de parsing.');
  }
});

// KAN-72: helper para construir un buffer .xlsx real en memoria, con una única pestaña y las
// filas pasadas como matriz (misma forma que sheet_to_json({header:1}) espera al leerlo de vuelta).
function buildXlsxBuffer(sheetName: string, rows: any[][]): Buffer {
  const worksheet = xlsx.utils.aoa_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('Excel Service - registra en priceParseErrors una fila con precio no interpretable como número', () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['domicilio', 'precio', 'dormitorios'],
    ['Calle Falsa 123', 'a consultar', 2]
  ]);

  const { properties, priceParseErrors } = processExcelBuffer(buffer);

  assert.strictEqual(properties.length, 1, 'La propiedad se agrega igual al catálogo.');
  assert.strictEqual(properties[0].price, 0, 'El precio no parseable queda en 0.');
  assert.strictEqual(priceParseErrors.length, 1, 'Debe registrarse un error de precio.');
  assert.strictEqual(priceParseErrors[0].address, 'Calle Falsa 123');
  assert.strictEqual(priceParseErrors[0].rawValue, 'a consultar');
  assert.strictEqual(priceParseErrors[0].sheetName, 'Ventas');
});

test('Excel Service - no registra error de precio cuando el precio es válido', () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['domicilio', 'precio', 'dormitorios'],
    ['Calle Falsa 123', '120000', 2]
  ]);

  const { properties, priceParseErrors } = processExcelBuffer(buffer);

  assert.strictEqual(properties[0].price, 120000);
  assert.strictEqual(priceParseErrors.length, 0, 'Un precio válido no debe generar error.');
});

test('Excel Service - Debería exportar función de sincronización de base de datos', () => {
  assert.strictEqual(typeof syncPropertiesToDatabase, 'function', 'syncPropertiesToDatabase debe ser una función.');
});

test('Excel Service - syncPropertiesToDatabase relanza el error cuando falla el fetch inicial de Supabase', async () => {
  const dbError = new Error('conexión rechazada por Supabase');
  const client = buildMockSupabaseClient({ selectResult: { data: null, error: dbError } });

  await assert.rejects(
    () => syncPropertiesToDatabase([buildSampleProperty()], 'tenant-1', client),
    (error: any) => {
      assert.strictEqual(error, dbError, 'Debe relanzar el mismo error recibido de Supabase.');
      return true;
    }
  );
});

test('Excel Service - syncPropertiesToDatabase relanza el error cuando falla el upsert', async () => {
  const dbError = new Error('violación de constraint');
  const client = buildMockSupabaseClient({
    selectResult: { data: [], error: null },
    mutationResult: { error: dbError }
  });

  await assert.rejects(
    () => syncPropertiesToDatabase([buildSampleProperty()], 'tenant-1', client),
    (error: any) => {
      assert.strictEqual(error, dbError, 'Debe relanzar el mismo error de upsert recibido de Supabase.');
      return true;
    }
  );
});

test('Excel Service - syncPropertiesToDatabase no lanza si la sincronización es exitosa', async () => {
  const client = buildMockSupabaseClient({
    selectResult: { data: [], error: null },
    mutationResult: { error: null }
  });

  await assert.doesNotReject(() => syncPropertiesToDatabase([buildSampleProperty()], 'tenant-1', client));
});

// Simula el bloque try/catch real de `POST /api/upload` (src/index.ts) con la función real
// syncPropertiesToDatabase — no importamos src/index.ts directamente porque ese módulo levanta
// el servidor completo al importarse (efecto secundario a nivel de módulo, `main()` sin guard
// `require.main === module`, mismo motivo documentado para el resto de los endpoints).
async function simulateUploadHandler(properties: Property[], tenantId: string, client: any) {
  const res = { statusCode: 200, body: undefined as any };
  try {
    await syncPropertiesToDatabase(properties, tenantId, client);
    res.statusCode = 200;
    res.body = { success: true, count: properties.length };
  } catch (error: any) {
    res.statusCode = 500;
    res.body = { error: error.message || 'Error interno al procesar el archivo.' };
  }
  return res;
}

test('Excel Service - el endpoint de upload responde 500 cuando syncPropertiesToDatabase falla', async () => {
  const client = buildMockSupabaseClient({ selectResult: { data: null, error: new Error('fallo de red') } });

  const res = await simulateUploadHandler([buildSampleProperty()], 'tenant-1', client);

  assert.strictEqual(res.statusCode, 500, 'El endpoint debe responder 500 ante un error de sincronización.');
  assert.ok(res.body.error, 'La respuesta 500 debe incluir un mensaje de error.');
});

test('Excel Service - el endpoint de upload responde 200 cuando syncPropertiesToDatabase tiene éxito', async () => {
  const client = buildMockSupabaseClient({ selectResult: { data: [], error: null } });

  const res = await simulateUploadHandler([buildSampleProperty()], 'tenant-1', client);

  assert.strictEqual(res.statusCode, 200, 'El endpoint debe responder 200 cuando la sincronización es exitosa.');
  assert.deepStrictEqual(res.body, { success: true, count: 1 });
});
