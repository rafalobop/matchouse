import test, { after } from 'node:test';
import assert from 'node:assert';
import * as xlsx from 'xlsx';
import {
  initExcelParsePool,
  stopExcelParsePool,
  peekExcelHeadersInWorker,
  parseExcelWithColumnMapInWorker,
  excelParsePoolSize
} from '../src/services/excelParsePool';

// Mismo helper que tests/excel.test.ts — construye un buffer .xlsx real en memoria.
function buildXlsxBuffer(sheetName: string, rows: any[][]): Buffer {
  const worksheet = xlsx.utils.aoa_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

const TRUNCATED_ZIP_BUFFER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

// Spawnea workers reales (worker_threads) — sin esto el proceso de test quedaría colgado al
// terminar (los workers mantienen vivo el event loop hasta que se los termina explícitamente).
after(async () => {
  await stopExcelParsePool();
});

test('excelParsePool (KAN-137) initExcelParsePool levanta config.excelParsePoolSize workers, e ignora llamadas repetidas', () => {
  initExcelParsePool(2);
  assert.strictEqual(excelParsePoolSize(), 2);
  initExcelParsePool(5); // no-op: el pool ya estaba inicializado
  assert.strictEqual(excelParsePoolSize(), 2);
});

test('excelParsePool (KAN-137) peekExcelHeadersInWorker resuelve con los headers reales, vía un worker thread', async () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['Domicilio', 'Precio'],
    ['Calle Falsa 123', '100000']
  ]);

  const result = await peekExcelHeadersInWorker(buffer);
  assert.deepStrictEqual(result, [{ sheetName: 'Ventas', headers: ['domicilio', 'precio'] }]);
});

test('excelParsePool (KAN-137) parseExcelWithColumnMapInWorker resuelve con las propiedades parseadas, vía un worker thread', async () => {
  const buffer = buildXlsxBuffer('Ventas', [
    ['Domicilio', 'Precio'],
    ['Calle Falsa 123', '100000']
  ]);
  const mappingsBySignature = new Map([
    ['domicilio|precio', { domicilio: 'domicilio', precio: 'precio' } as any]
  ]);

  const result = await parseExcelWithColumnMapInWorker(buffer, mappingsBySignature);
  assert.strictEqual(result.properties.length, 1);
  assert.strictEqual(result.properties[0].address, 'Calle Falsa 123');
});

test('excelParsePool (KAN-137) un archivo corrupto rechaza la promesa con el mensaje de error del worker, sin colgar el pool', async () => {
  await assert.rejects(() => peekExcelHeadersInWorker(TRUNCATED_ZIP_BUFFER));

  // El pool debe seguir funcionando normalmente después de un error de parseo puntual — no debe
  // quedar ningún worker "trabado" en busy ni el pool degradado (AC4: el error en una tarea no
  // afecta el rendimiento general del resto del sistema).
  const buffer = buildXlsxBuffer('Ventas', [['Domicilio', 'Precio'], ['Y', '2']]);
  const result = await peekExcelHeadersInWorker(buffer);
  assert.strictEqual(result.length, 1);
});

test('excelParsePool (KAN-137) más tareas concurrentes que workers en el pool: todas resuelven correctamente vía la cola', async () => {
  const buffers = Array.from({ length: 6 }, (_, i) =>
    buildXlsxBuffer('Ventas', [['Domicilio', 'Precio'], [`Calle ${i}`, String(100000 + i)]])
  );

  // El pool tiene 2 workers (test de arriba) — 6 tareas concurrentes fuerzan la cola interna.
  const results = await Promise.all(buffers.map(b => peekExcelHeadersInWorker(b)));

  results.forEach((result, i) => {
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].sheetName, 'Ventas');
  });
});
