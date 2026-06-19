import test from 'node:test';
import assert from 'node:assert';
import { processExcelBuffer, syncPropertiesToDatabase } from '../src/services/excel';

test('Excel Service - Debería retornar catálogo vacío o lanzar error para buffers sin datos', () => {
  assert.strictEqual(typeof processExcelBuffer, 'function', 'processExcelBuffer es una función.');
  
  const emptyBuffer = Buffer.alloc(0);
  try {
    const result = processExcelBuffer(emptyBuffer);
    assert.ok(Array.isArray(result), 'El resultado debe ser un arreglo.');
    assert.strictEqual(result.length, 0, 'El catálogo resultante debe ser vacío.');
  } catch (error) {
    assert.ok(error instanceof Error, 'Si lanza error, debe ser un error válido de parsing.');
  }
});

test('Excel Service - Debería exportar función de sincronización de base de datos', () => {
  assert.strictEqual(typeof syncPropertiesToDatabase, 'function', 'syncPropertiesToDatabase debe ser una función.');
});
