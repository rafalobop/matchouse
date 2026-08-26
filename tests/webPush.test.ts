import test from 'node:test';
import assert from 'node:assert';
import { hasActivePushSubscriptions, buildIncomingMatchPushPayload } from '../src/services/webPush';

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

test('webPush.buildIncomingMatchPushPayload (KAN-303) - un solo id arma data.url con ?highlight=<id> sin codificar', () => {
  const payload = buildIncomingMatchPushPayload('match-abc');

  assert.strictEqual((payload.data as any).url, '/matches?highlight=match-abc');
  assert.strictEqual(payload.tag, 'incoming-match-match-abc');
});

test('webPush.buildIncomingMatchPushPayload (KAN-303) - varios ids se unen con coma (codificada) en un solo highlight', () => {
  const payload = buildIncomingMatchPushPayload(['match-1', 'match-2']);

  assert.strictEqual((payload.data as any).url, '/matches?highlight=match-1%2Cmatch-2');
  assert.strictEqual(payload.tag, 'incoming-match-match-1', 'El tag usa el primer id como referencia de dedup del navegador.');
});

test('webPush.buildIncomingMatchPushPayload (KAN-303) - ids null/undefined en el array se filtran sin romper', () => {
  const payload = buildIncomingMatchPushPayload([null, 'match-real', undefined] as any);

  assert.strictEqual((payload.data as any).url, '/matches?highlight=match-real');
});

test('webPush.buildIncomingMatchPushPayload (KAN-303) - sin ningún id válido, cae a un tag "unknown" en vez de romper', () => {
  const payload = buildIncomingMatchPushPayload([]);

  assert.strictEqual(payload.tag, 'incoming-match-unknown');
  assert.strictEqual((payload.data as any).url, '/matches?highlight=');
});
