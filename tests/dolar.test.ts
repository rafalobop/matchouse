import test from 'node:test';
import assert from 'node:assert';
import { getDolarBlueRate, loadCachedRate } from '../src/services/dolar';

test('Dolar Service - Debería retornar cotizaciones y tener un fallback inicial', () => {
  const initialRate = loadCachedRate();
  assert.ok(initialRate >= 1000, 'La tasa inicial del dólar debería ser mayor o igual a 1000.');
  assert.strictEqual(getDolarBlueRate(), initialRate, 'El getter en memoria debería retornar el valor inicial cargado.');
});
