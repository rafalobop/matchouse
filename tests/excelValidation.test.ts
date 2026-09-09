import test from 'node:test';
import assert from 'node:assert';
import * as xlsx from 'xlsx';
import { validateExcelFile } from '../src/services/excelValidation';
import { config } from '../src/config/env';

// Mismo helper que tests/excel.test.ts: buffer .xlsx real en memoria con una pestaña y filas
// como matriz (misma forma que sheet_to_json({header:1}) espera al leerlo de vuelta).
function buildXlsxBuffer(sheetName: string, rows: any[][]): Buffer {
  const worksheet = xlsx.utils.aoa_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function buildRows(totalRows: number): any[][] {
  const rows: any[][] = [['domicilio', 'precio']];
  for (let i = 1; i < totalRows; i++) {
    rows.push([`Calle Falsa ${i}`, '100000']);
  }
  return rows;
}

test('excelValidation - acepta un archivo dentro de los límites de tamaño y filas', () => {
  const buffer = buildXlsxBuffer('Ventas', buildRows(10));
  const result = validateExcelFile({ buffer, fileSizeBytes: buffer.length });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.reason, undefined);
});

test('excelValidation - acepta un archivo con exactamente config.excelMaxRows filas', () => {
  const buffer = buildXlsxBuffer('Ventas', buildRows(config.excelMaxRows));
  const result = validateExcelFile({ buffer, fileSizeBytes: buffer.length });
  assert.strictEqual(result.valid, true);
});

test('excelValidation - rechaza un archivo que supera config.excelMaxRows filas en una hoja', () => {
  const buffer = buildXlsxBuffer('Ventas', buildRows(config.excelMaxRows + 1));
  const result = validateExcelFile({ buffer, fileSizeBytes: buffer.length });
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes('Ventas'), 'El motivo debe mencionar la hoja responsable.');
  assert.ok(result.reason?.includes(String(config.excelMaxRows)), 'El motivo debe mencionar el límite configurado.');
});

test('excelValidation - rechaza un archivo que supera config.uploadMaxFileSizeBytes', () => {
  const buffer = buildXlsxBuffer('Ventas', buildRows(5));
  const result = validateExcelFile({ buffer, fileSizeBytes: config.uploadMaxFileSizeBytes + 1 });
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.toLowerCase().includes('tamaño'), 'El motivo debe indicar que es un problema de tamaño.');
});

test('excelValidation - la validación de tamaño corta antes de leer el buffer (no falla con contenido inválido)', () => {
  const bogusBuffer = Buffer.from('esto no es un xlsx real');
  const result = validateExcelFile({ buffer: bogusBuffer, fileSizeBytes: config.uploadMaxFileSizeBytes + 1 });
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.toLowerCase().includes('tamaño'));
});

test('excelValidation - rechaza la primera hoja que exceda el límite entre varias pestañas', () => {
  const worksheetOk = xlsx.utils.aoa_to_sheet(buildRows(10));
  const worksheetBad = xlsx.utils.aoa_to_sheet(buildRows(config.excelMaxRows + 1));
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheetOk, 'Ok');
  xlsx.utils.book_append_sheet(workbook, worksheetBad, 'Excedida');
  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const result = validateExcelFile({ buffer, fileSizeBytes: buffer.length });
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason?.includes('Excedida'));
});
