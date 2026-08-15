import test from 'node:test';
import assert from 'node:assert';
import { sanitizeMetricNumber } from '../src/utils/dashboardMetrics';

test('sanitizeMetricNumber (KAN-128) - devuelve el número tal cual si es válido y está dentro del tope', () => {
  assert.strictEqual(sanitizeMetricNumber(42, 1000), 42);
  assert.strictEqual(sanitizeMetricNumber(0, 1000), 0);
});

test('sanitizeMetricNumber (KAN-128) - acota al tope si el valor lo supera', () => {
  assert.strictEqual(sanitizeMetricNumber(5000, 1000), 1000);
});

test('sanitizeMetricNumber (KAN-128) - devuelve 0 para negativos', () => {
  assert.strictEqual(sanitizeMetricNumber(-5, 1000), 0);
});

test('sanitizeMetricNumber (KAN-128) - devuelve 0 para NaN/Infinity', () => {
  assert.strictEqual(sanitizeMetricNumber(NaN, 1000), 0);
  assert.strictEqual(sanitizeMetricNumber(Infinity, 1000), 0);
});

test('sanitizeMetricNumber (KAN-128) - devuelve 0 para valores no numéricos (string, null, undefined, objeto)', () => {
  assert.strictEqual(sanitizeMetricNumber('100', 1000), 0);
  assert.strictEqual(sanitizeMetricNumber(null, 1000), 0);
  assert.strictEqual(sanitizeMetricNumber(undefined, 1000), 0);
  assert.strictEqual(sanitizeMetricNumber({ value: 100 }, 1000), 0);
});
