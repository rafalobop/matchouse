import test from 'node:test';
import assert from 'node:assert';
import * as xlsx from 'xlsx';
import { processExcelBuffer, processExcelBufferWithColumnMap, peekExcelHeaders, syncPropertiesToDatabase, Property } from '../src/services/excel';
import { GeocodeResult } from '../src/services/geocoding';
import { computeHeaderSignature, matchHeadersHeuristically } from '../src/utils/excelHeaderMatcher';

// Mock mínimo del builder encadenable de Supabase, mismo patrón que tests/searchExpiration.test.ts.
// `selectResult` controla la respuesta del fetch inicial (paso 1); `mutationResult` controla
// la respuesta de upsert/delete (paso 5). `upsertedRows` (KAN-80) captura el payload real
// mandado a `.upsert()` para poder assertear las coordenadas resueltas.
function buildMockSupabaseClient(options: {
  selectResult: { data: any[] | null; error: any };
  mutationResult?: { error: any };
  upsertedRows?: any[];
}) {
  const mutationResult = options.mutationResult ?? { error: null };
  return {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve(options.selectResult)
      }),
      upsert: (rows: any[]) => {
        options.upsertedRows?.push(...rows);
        return Promise.resolve(mutationResult);
      },
      delete: () => ({
        in: () => ({
          eq: () => Promise.resolve(mutationResult)
        })
      })
    })
  } as any;
}

// KAN-80: la mayoría de los tests preexistentes no le importa la geocodificación — se les da
// lat/lng explícitas por default para que syncPropertiesToDatabase nunca dispare el path de
// geocoding (que sin un `geocodeFn` inyectado pegaría a la red real). Los tests dedicados de
// geocoding más abajo pisan `latitude`/`longitude` a `undefined` a propósito.
function buildSampleProperty(overrides: Partial<Property> = {}): Property {
  return {
    address: 'Calle Falsa 123',
    price: 100000,
    currency: 'USD',
    bedrooms: 2,
    property_type: 'departamento',
    operation: 'venta',
    sheet_name: 'Hoja1',
    latitude: -26.82,
    longitude: -65.2,
    ...overrides
  } as Property;
}

function buildFakeGeocodeFn(result: GeocodeResult): (query: string) => Promise<GeocodeResult> {
  return async () => result;
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

// --- KAN-80: GeocodingService integrado en syncPropertiesToDatabase ---

test('Excel Service - geocodifica una propiedad sin lat/lng en el Excel y persiste el resultado', async () => {
  const upsertedRows: any[] = [];
  const client = buildMockSupabaseClient({ selectResult: { data: [], error: null }, upsertedRows });
  const property = buildSampleProperty({ latitude: undefined, longitude: undefined });

  let calledWith: string | undefined;
  const geocodeFn = async (query: string): Promise<GeocodeResult> => {
    calledWith = query;
    return { success: true, latitude: -26.83, longitude: -65.21 };
  };

  await syncPropertiesToDatabase([property], 'tenant-1', client, geocodeFn);

  assert.ok(calledWith?.includes('Calle Falsa 123'), 'Debe geocodificar usando la dirección de la propiedad.');
  assert.strictEqual(upsertedRows.length, 1);
  assert.strictEqual(upsertedRows[0].latitude, -26.83);
  assert.strictEqual(upsertedRows[0].longitude, -65.21);
});

test('Excel Service - una propiedad con geocoding fallido se persiste con lat/lng null (no 0/0)', async () => {
  const upsertedRows: any[] = [];
  const client = buildMockSupabaseClient({ selectResult: { data: [], error: null }, upsertedRows });
  const property = buildSampleProperty({ latitude: undefined, longitude: undefined });

  await syncPropertiesToDatabase(
    [property],
    'tenant-1',
    client,
    buildFakeGeocodeFn({ success: false, reason: 'No se encontraron coordenadas para la dirección' })
  );

  assert.strictEqual(upsertedRows.length, 1);
  assert.strictEqual(upsertedRows[0].latitude, null, 'Debe quedar null, nunca 0, para que quede excluida del matching espacial.');
  assert.strictEqual(upsertedRows[0].longitude, null);
});

test('Excel Service - no re-geocodifica una propiedad sin cambios que ya tenía coordenadas en la base', async () => {
  const upsertedRows: any[] = [];
  const client = buildMockSupabaseClient({
    selectResult: {
      data: [{
        id: 'prop-1',
        address: 'Calle Falsa 123',
        floor: null,
        unit: null,
        block: null,
        lot: null,
        price: 100000,
        contact_info: null,
        sheet_name: 'Hoja1',
        latitude: -26.9,
        longitude: -65.3
      }],
      error: null
    },
    upsertedRows
  });
  const property = buildSampleProperty({ latitude: undefined, longitude: undefined });

  let geocodeCalls = 0;
  const geocodeFn = async (): Promise<GeocodeResult> => {
    geocodeCalls++;
    return { success: true, latitude: 0, longitude: 0 };
  };

  await syncPropertiesToDatabase([property], 'tenant-1', client, geocodeFn);

  assert.strictEqual(geocodeCalls, 0, 'No debe llamar al geocoder si la propiedad ya existe con coordenadas resueltas.');
  assert.strictEqual(upsertedRows[0].latitude, -26.9, 'Debe reutilizar la coordenada ya guardada en la base.');
  assert.strictEqual(upsertedRows[0].longitude, -65.3);
});

test('Excel Service - respeta lat/lng explícitas del Excel sin llamar al geocoder', async () => {
  const upsertedRows: any[] = [];
  const client = buildMockSupabaseClient({ selectResult: { data: [], error: null }, upsertedRows });
  const property = buildSampleProperty({ latitude: -26.5, longitude: -65.1 });

  let geocodeCalls = 0;
  const geocodeFn = async (): Promise<GeocodeResult> => {
    geocodeCalls++;
    return { success: true, latitude: 0, longitude: 0 };
  };

  await syncPropertiesToDatabase([property], 'tenant-1', client, geocodeFn);

  assert.strictEqual(geocodeCalls, 0, 'Una columna de coordenadas explícita en el Excel no debe disparar geocoding.');
  assert.strictEqual(upsertedRows[0].latitude, -26.5);
  assert.strictEqual(upsertedRows[0].longitude, -65.1);
});

// --- KAN-84: peekExcelHeaders / processExcelBufferWithColumnMap ---

test('peekExcelHeaders - devuelve los headers normalizados de cada hoja no vacía', () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['Domicilio', 'Precio', 'Dormitorios'],
    ['Calle Falsa 123', '100000', 2]
  ]);

  const result = peekExcelHeaders(buffer);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].sheetName, 'Ventas');
  assert.deepStrictEqual(result[0].headers, ['domicilio', 'precio', 'dormitorios']);
});

test('peekExcelHeaders - omite hojas vacías o sin filas de datos', () => {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['Domicilio', 'Precio']]), 'SoloHeaders');
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['Domicilio', 'Precio'], ['Calle Falsa 123', '100000']]), 'ConDatos');
  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const result = peekExcelHeaders(buffer);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].sheetName, 'ConDatos');
});

test('processExcelBufferWithColumnMap - parsea usando el mapeo provisto (headers renombrados que la heurística por defecto no reconocería)', () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['Address', 'Price'],
    ['Calle Falsa 123', '150000']
  ]);
  const headers = peekExcelHeaders(buffer)[0].headers;
  const mappings = new Map([[computeHeaderSignature(headers), { domicilio: 'address', precio: 'price' }]]);

  const result = processExcelBufferWithColumnMap(buffer, mappings);

  assert.strictEqual(result.properties.length, 1);
  assert.strictEqual(result.properties[0].address, 'Calle Falsa 123');
  assert.strictEqual(result.properties[0].price, 150000);
});

test('processExcelBufferWithColumnMap - omite una hoja cuya firma no está en el mapa provisto', () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['Address', 'Price'],
    ['Calle Falsa 123', '150000']
  ]);

  const result = processExcelBufferWithColumnMap(buffer, new Map());

  assert.strictEqual(result.properties.length, 0);
});

test('processExcelBuffer y processExcelBufferWithColumnMap producen el mismo resultado para headers estándar en español', () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['Domicilio', 'Precio', 'Dormitorios'],
    ['Calle Falsa 123', '100000', 2]
  ]);
  const headers = peekExcelHeaders(buffer)[0].headers;
  const heuristic = matchHeadersHeuristically(headers);
  const mapping: Record<string, string | null> = {};
  for (const f of heuristic.fields) mapping[f.field] = f.header;
  const mappings = new Map([[computeHeaderSignature(headers), mapping]]);

  const defaultResult = processExcelBuffer(buffer);
  const mappedResult = processExcelBufferWithColumnMap(buffer, mappings);

  assert.deepStrictEqual(mappedResult.properties, defaultResult.properties);
});
