import test from 'node:test';
import assert from 'node:assert';
import { getTucumanLocalities, TUCUMAN_LOCALITIES_FALLBACK, __clearTucumanLocalitiesCacheForTests } from '../src/services/localitiesService';

// KAN-93: `fetchImpl` es inyectable a propósito para no pegarle a la API real de Georef en la
// suite. El cache interno se limpia antes de cada test para que cada uno controle su propia
// respuesta (si no, el primer test que resuelve OK queda cacheado 24hs y los siguientes ni
// llaman al fetchImpl inyectado).

function buildFakeFetch(response: { ok: boolean; status?: number; body?: any }): typeof fetch {
  return (async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body
  })) as unknown as typeof fetch;
}

test.beforeEach(() => {
  __clearTucumanLocalitiesCacheForTests();
});

test('localitiesService - devuelve el listado real, ordenado alfabéticamente y sin duplicados', async () => {
  const fakeFetch = buildFakeFetch({
    ok: true,
    body: { localidades: [{ nombre: 'Yerba Buena' }, { nombre: 'Tafí Viejo' }, { nombre: 'Yerba Buena' }] }
  });

  const result = await getTucumanLocalities(fakeFetch);

  assert.deepStrictEqual(result, ['Tafí Viejo', 'Yerba Buena']);
});

test('localitiesService - cachea el resultado exitoso (no vuelve a llamar al fetchImpl)', async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ localidades: [{ nombre: 'San Miguel de Tucumán' }] }) } as any;
  }) as unknown as typeof fetch;

  await getTucumanLocalities(fakeFetch);
  await getTucumanLocalities(fakeFetch);

  assert.strictEqual(calls, 1);
});

test('localitiesService - ante un error HTTP cae al listado de respaldo, sin lanzar', async () => {
  const fakeFetch = buildFakeFetch({ ok: false, status: 503 });

  const result = await getTucumanLocalities(fakeFetch);

  assert.deepStrictEqual(result, TUCUMAN_LOCALITIES_FALLBACK);
});

test('localitiesService - ante un fallo de red (fetch rechaza) cae al listado de respaldo, sin lanzar', async () => {
  const rejectingFetch = (async () => {
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;

  const result = await getTucumanLocalities(rejectingFetch);

  assert.deepStrictEqual(result, TUCUMAN_LOCALITIES_FALLBACK);
});

test('localitiesService - ante una respuesta sin localidades cae al listado de respaldo', async () => {
  const fakeFetch = buildFakeFetch({ ok: true, body: { localidades: [] } });

  const result = await getTucumanLocalities(fakeFetch);

  assert.deepStrictEqual(result, TUCUMAN_LOCALITIES_FALLBACK);
});

test('localitiesService - un fallo no cachea el fallback (reintenta la API real la próxima vez)', async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return { ok: false, status: 503, json: async () => ({}) } as any;
  }) as unknown as typeof fetch;

  await getTucumanLocalities(fakeFetch);
  await getTucumanLocalities(fakeFetch);

  assert.strictEqual(calls, 2, 'Cada llamada tras un fallo debe reintentar la API, no quedar pegada al fallback cacheado.');
});

test('localitiesService - el listado de respaldo incluye las localidades mencionadas en el ticket (KAN-93)', () => {
  assert.ok(TUCUMAN_LOCALITIES_FALLBACK.includes('San Miguel de Tucumán'));
  assert.ok(TUCUMAN_LOCALITIES_FALLBACK.includes('Yerba Buena'));
  assert.ok(TUCUMAN_LOCALITIES_FALLBACK.includes('Tafí Viejo'));
});
