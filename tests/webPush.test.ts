import test from 'node:test';
import assert from 'node:assert';
import { buildMatchFoundPushPayload, hasActivePushSubscriptions } from '../src/services/webPush';

// Mismo estilo de mock de query builder encadenable usado en tests/searchExpiration.test.ts.
function makeMockClient(options: { count?: number | null; error?: any } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const builder: any = {
    select: (...args: any[]) => { calls.push({ method: 'select', args }); return builder; },
    eq: (...args: any[]) => {
      calls.push({ method: 'eq', args });
      return Promise.resolve({ count: options.count ?? null, error: options.error ?? null });
    }
  };
  return {
    from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder; },
    calls
  };
}

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

test('webPush.hasActivePushSubscriptions (KAN-48) - true cuando el tenant tiene al menos una suscripción', async () => {
  const mockClient = makeMockClient({ count: 2 });

  assert.strictEqual(await hasActivePushSubscriptions('tenant-1', mockClient as any), true);
});

test('webPush.hasActivePushSubscriptions (KAN-48) - false cuando el tenant no tiene suscripciones', async () => {
  const mockClient = makeMockClient({ count: 0 });

  assert.strictEqual(await hasActivePushSubscriptions('tenant-1', mockClient as any), false);
});

test('webPush.hasActivePushSubscriptions - false cuando count viene null (sin filas)', async () => {
  const mockClient = makeMockClient({ count: null });

  assert.strictEqual(await hasActivePushSubscriptions('tenant-1', mockClient as any), false);
});

test('webPush.hasActivePushSubscriptions - fail-open a false ante un error del cliente (dispara el fallback de email antes que perder el aviso)', async () => {
  const mockClient = makeMockClient({ error: { message: 'fallo simulado' } });

  assert.strictEqual(await hasActivePushSubscriptions('tenant-1', mockClient as any), false);
});

test('webPush.hasActivePushSubscriptions - consulta la tabla y el tenant correctos', async () => {
  const mockClient = makeMockClient({ count: 1 });

  await hasActivePushSubscriptions('tenant-42', mockClient as any);

  assert.deepStrictEqual(mockClient.calls[0], { method: 'from', args: ['web_push_subscriptions'] });
  assert.deepStrictEqual(mockClient.calls[2], { method: 'eq', args: ['tenant_id', 'tenant-42'] });
});
