import test from 'node:test';
import assert from 'node:assert';
import { buildMatchFoundPushPayload } from '../src/services/webPush';

test('webPush.buildMatchFoundPushPayload - usa el texto minimizado exacto definido en KAN-45', () => {
  const payload = buildMatchFoundPushPayload('search-123');

  assert.strictEqual(payload.title, 'Matchouse');
  assert.strictEqual(payload.body, 'Tenés un match nuevo — tocá para ver');
});

test('webPush.buildMatchFoundPushPayload - no incluye dirección, precio ni datos de contacto sin importar el searchId', () => {
  const payload = buildMatchFoundPushPayload('search-456');
  const serialized = JSON.stringify(payload);

  assert.ok(!/domicilio|direcci[oó]n|precio|contacto|address|price/i.test(serialized), 'El payload no debe filtrar datos de la propiedad.');
});

test('webPush.buildMatchFoundPushPayload - el texto no depende del searchId ni de un conteo de matches (regresión KAN-45)', () => {
  const payloadA = buildMatchFoundPushPayload('search-A');
  const payloadB = buildMatchFoundPushPayload('search-B');

  assert.strictEqual(payloadA.title, payloadB.title);
  assert.strictEqual(payloadA.body, payloadB.body);
});

test('webPush.buildMatchFoundPushPayload - genera un tag distinto por búsqueda para que las notificaciones no se pisen entre sí', () => {
  const payload = buildMatchFoundPushPayload('search-789');

  assert.strictEqual(payload.tag, 'search-match-search-789');
  assert.deepStrictEqual(payload.data, { url: '/' });
});
