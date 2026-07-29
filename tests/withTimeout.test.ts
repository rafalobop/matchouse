import test from 'node:test';
import assert from 'node:assert';
import { withTimeout, TimeoutError } from '../src/utils/withTimeout';

test('withTimeout - resuelve con el valor original cuando la promesa termina antes del límite', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000, 'test rápido');
  assert.strictEqual(result, 'ok');
});

test('withTimeout - rechaza con TimeoutError cuando la promesa no resuelve dentro del límite', async () => {
  const neverResolves = new Promise(() => {});

  await assert.rejects(
    () => withTimeout(neverResolves, 20, 'promesa colgada'),
    (error: any) => {
      assert.ok(error instanceof TimeoutError, 'El error debe ser una instancia de TimeoutError.');
      assert.strictEqual(error.name, 'TimeoutError');
      assert.match(error.message, /promesa colgada/, 'El mensaje debe incluir el label provisto.');
      assert.match(error.message, /20ms/, 'El mensaje debe incluir el límite de tiempo usado.');
      return true;
    }
  );
});

test('withTimeout - propaga el error original cuando la promesa rechaza antes del límite', async () => {
  const originalError = new Error('fallo real de la promesa');

  await assert.rejects(
    () => withTimeout(Promise.reject(originalError), 1000, 'test de rechazo'),
    (error: any) => {
      assert.strictEqual(error, originalError, 'Debe relanzar el mismo error original, no un TimeoutError.');
      return true;
    }
  );
});

test('withTimeout - no deja el timer colgado tras una resolución exitosa (no debería bloquear el proceso)', async () => {
  // Si el timer no se limpia con clearTimeout, este test seguiría "vivo" ~50ms de más;
  // no hay una forma directa de assertear un clearTimeout desde afuera, así que se verifica
  // el comportamiento observable: la promesa se resuelve y no rechaza más tarde con timeout.
  let rejected = false;
  await withTimeout(Promise.resolve('valor'), 30, 'resolución rápida').catch(() => { rejected = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(rejected, false, 'No debe rechazar tardíamente después de ya haber resuelto.');
});
