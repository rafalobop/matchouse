import test from 'node:test';
import assert from 'node:assert';
import { withRetry } from '../src/utils/withRetry';

test('withRetry - resuelve en el primer intento si fn no falla', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; }, { attempts: 3, baseDelayMs: 1 });

  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 1);
});

test('withRetry - reintenta y resuelve si un intento posterior tiene éxito', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error(`fallo intento ${calls}`);
    return 'ok';
  }, { attempts: 3, baseDelayMs: 1 });

  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 3);
});

test('withRetry - agota los intentos y rechaza con el último error', async () => {
  let calls = 0;

  await assert.rejects(
    () => withRetry(async () => {
      calls++;
      throw new Error(`fallo intento ${calls}`);
    }, { attempts: 3, baseDelayMs: 1 }),
    /fallo intento 3/
  );

  assert.strictEqual(calls, 3);
});

test('withRetry - usa los defaults (3 intentos) si no se pasan options', async () => {
  let calls = 0;

  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error('siempre falla'); }, { baseDelayMs: 1 }),
    /siempre falla/
  );

  assert.strictEqual(calls, 3);
});

test('withRetry - con attempts: 1 no reintenta, rechaza directo', async () => {
  let calls = 0;

  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error('único intento'); }, { attempts: 1, baseDelayMs: 1 }),
    /único intento/
  );

  assert.strictEqual(calls, 1);
});
