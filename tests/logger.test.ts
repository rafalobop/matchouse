import test from 'node:test';
import assert from 'node:assert';
import { logger } from '../src/services/logger';

test('Logger Service - Debería estar inicializado y tener niveles de logging', () => {
  assert.ok(logger, 'El logger debería estar definido.');
  assert.strictEqual(typeof logger.info, 'function', 'logger.info debería ser una función.');
  assert.strictEqual(typeof logger.error, 'function', 'logger.error debería ser una función.');
});
