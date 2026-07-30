import test from 'node:test';
import assert from 'node:assert';
import { geocodeAddress, __resetGeocodingThrottleForTests } from '../src/services/geocoding';

// KAN-80: `fetchImpl` es inyectable a propósito para no pegarle a Nominatim real en la suite
// (ni violar su política de uso, ni depender de red/latencia en tests). El throttle interno se
// resetea antes de cada test para no arrastrar el delay de 1.1s entre tests reales.

function buildFakeFetch(response: { ok: boolean; status?: number; body?: any }): typeof fetch {
  return (async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body
  })) as unknown as typeof fetch;
}

test.beforeEach(() => {
  __resetGeocodingThrottleForTests();
});

test('geocoding - devuelve coordenadas cuando el servicio responde con un resultado válido', async () => {
  const fakeFetch = buildFakeFetch({ ok: true, body: [{ lat: '-26.82', lon: '-65.24' }] });

  const result = await geocodeAddress('Calle Falsa 123, Tucumán, Argentina', fakeFetch);

  assert.strictEqual(result.success, true);
  if (result.success) {
    assert.strictEqual(result.latitude, -26.82);
    assert.strictEqual(result.longitude, -65.24);
  }
});

test('geocoding - falla de forma controlada cuando no hay resultados', async () => {
  const fakeFetch = buildFakeFetch({ ok: true, body: [] });

  const result = await geocodeAddress('Dirección inexistente, Tucumán, Argentina', fakeFetch);

  assert.strictEqual(result.success, false);
  if (!result.success) {
    assert.ok(result.reason.length > 0);
  }
});

test('geocoding - falla de forma controlada ante un error HTTP', async () => {
  const fakeFetch = buildFakeFetch({ ok: false, status: 503 });

  const result = await geocodeAddress('Calle Falsa 123', fakeFetch);

  assert.strictEqual(result.success, false);
});

test('geocoding - falla de forma controlada si el fetch rechaza (error de red)', async () => {
  const rejectingFetch = (async () => {
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;

  const result = await geocodeAddress('Calle Falsa 123', rejectingFetch);

  assert.strictEqual(result.success, false);
  if (!result.success) {
    assert.ok(result.reason.includes('ECONNRESET'));
  }
});

test('geocoding - falla de forma controlada ante coordenadas no numéricas', async () => {
  const fakeFetch = buildFakeFetch({ ok: true, body: [{ lat: 'no-es-un-numero', lon: '-65.24' }] });

  const result = await geocodeAddress('Calle Falsa 123', fakeFetch);

  assert.strictEqual(result.success, false);
});

test('geocoding - una consulta vacía no dispara ningún fetch', async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => [] } as any;
  }) as unknown as typeof fetch;

  const result = await geocodeAddress('   ', fakeFetch);

  assert.strictEqual(result.success, false);
  assert.strictEqual(called, false);
});
