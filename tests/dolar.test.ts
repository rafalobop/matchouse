import test from 'node:test';
import assert from 'node:assert';
import { getDolarBlueRate, loadCachedRate, startDolarService, stopDolarService } from '../src/services/dolar';

test('Dolar Service - Debería retornar cotizaciones y tener un fallback inicial', () => {
  const initialRate = loadCachedRate();
  assert.ok(initialRate >= 1000, 'La tasa inicial del dólar debería ser mayor o igual a 1000.');
  assert.strictEqual(getDolarBlueRate(), initialRate, 'El getter en memoria debería retornar el valor inicial cargado.');
});

test('Dolar Service - El intervalo no debe generar unhandled rejections si falla la actualización', async (t) => {
  t.mock.method(global, 'fetch', async () => {
    throw new Error('network down');
  });

  let unhandled = false;
  const onUnhandledRejection = () => {
    unhandled = true;
  };
  process.on('unhandledRejection', onUnhandledRejection);

  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    startDolarService();
    t.mock.timers.tick(3600000);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    stopDolarService();
    t.mock.timers.reset();
    process.off('unhandledRejection', onUnhandledRejection);
  }

  assert.strictEqual(unhandled, false, 'El fallo de la actualización dentro del intervalo no debe escapar como unhandled rejection.');
});
