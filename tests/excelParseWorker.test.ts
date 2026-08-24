import test from 'node:test';
import assert from 'node:assert';
import * as xlsx from 'xlsx';
import { randomUUID } from 'crypto';
import { runExcelParseTask } from '../src/services/excelParseWorker';

// Mismo helper que tests/excel.test.ts — construye un buffer .xlsx real en memoria.
function buildXlsxBuffer(sheetName: string, rows: any[][]): Buffer {
  const worksheet = xlsx.utils.aoa_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('runExcelParseTask (KAN-137) peekHeaders devuelve los headers de cada hoja no vacía', () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['Domicilio', 'Precio'],
    ['Calle Falsa 123', '100000']
  ]);
  const response = runExcelParseTask({ taskId: 't1', type: 'peekHeaders', buffer });

  assert.strictEqual(response.type, 'result');
  assert.strictEqual(response.taskId, 't1');
  if (response.type === 'result') {
    assert.deepStrictEqual(response.result, [{ sheetName: 'Ventas', headers: ['domicilio', 'precio'] }]);
  }
});

test('runExcelParseTask (KAN-137) parseWithColumnMap devuelve las propiedades resueltas por el mapeo dado', () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['Domicilio', 'Precio'],
    ['Calle Falsa 123', '100000']
  ]);
  const mappingsBySignature = new Map([
    ['domicilio|precio', { domicilio: 'domicilio', precio: 'precio' }]
  ]);

  const response = runExcelParseTask({
    taskId: randomUUID(),
    type: 'parseWithColumnMap',
    buffer,
    mappingsBySignature: mappingsBySignature as any
  });

  assert.strictEqual(response.type, 'result');
  if (response.type === 'result' && 'properties' in response.result) {
    assert.strictEqual(response.result.properties.length, 1);
    assert.strictEqual(response.result.properties[0].address, 'Calle Falsa 123');
    assert.strictEqual(response.result.properties[0].price, 100000);
  }
});

// xlsx.read es muy permisivo (texto plano, binario random, ceros: todo lo interpreta como una
// hoja "Sheet1" en vez de tirar) — el único caso que confirmamos que efectivamente lanza una
// excepción real es un buffer que arranca con la magia de ZIP (los .xlsx son un ZIP) pero está
// truncado/corrupto adentro. Verificado manualmente antes de escribir este test (no es un
// supuesto sin chequear): dispara "Unsupported ZIP encryption" en xlsx.read.
const TRUNCATED_ZIP_BUFFER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

test('runExcelParseTask (KAN-137) un buffer corrupto (ZIP truncado) responde error en vez de tirar una excepción', () => {
  const response = runExcelParseTask({ taskId: 't2', type: 'peekHeaders', buffer: TRUNCATED_ZIP_BUFFER });

  assert.strictEqual(response.type, 'error');
  assert.strictEqual(response.taskId, 't2');
  if (response.type === 'error') {
    assert.ok(response.message.length > 0, 'El mensaje de error debe venir con contenido.');
  }
});

test('runExcelParseTask (KAN-137) preserva el taskId de la request en la respuesta, sea éxito o error', () => {
  const buffer = buildXlsxBuffer('Ventas', [['Domicilio', 'Precio'], ['X', '1']]);
  const okResponse = runExcelParseTask({ taskId: 'abc-123', type: 'peekHeaders', buffer });
  const errResponse = runExcelParseTask({ taskId: 'def-456', type: 'peekHeaders', buffer: TRUNCATED_ZIP_BUFFER });

  assert.strictEqual(okResponse.taskId, 'abc-123');
  assert.strictEqual(errResponse.taskId, 'def-456');
});
