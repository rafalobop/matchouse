import test from 'node:test';
import assert from 'node:assert';
import { notifyMatchFound } from '../src/services/notifications';

function makeDeps(hasPush: boolean) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      hasActivePush: async () => { calls.push('hasActivePush'); return hasPush; },
      sendPush: async () => { calls.push('sendPush'); },
      sendEmailFallback: async () => { calls.push('sendEmailFallback'); return true; }
    }
  };
}

test('notifyMatchFound (KAN-48) - con push activo, envía push y NO el email de respaldo', async () => {
  const { deps, calls } = makeDeps(true);

  const channel = await notifyMatchFound(deps);

  assert.strictEqual(channel, 'push');
  assert.deepStrictEqual(calls, ['hasActivePush', 'sendPush']);
});

test('notifyMatchFound (KAN-48 AC1) - sin push activo, envía el email de respaldo en vez del push', async () => {
  const { deps, calls } = makeDeps(false);

  const channel = await notifyMatchFound(deps);

  assert.strictEqual(channel, 'email');
  assert.deepStrictEqual(calls, ['hasActivePush', 'sendEmailFallback']);
});

test('notifyMatchFound (KAN-48 AC5) - nunca dispara push y email para el mismo evento', async () => {
  const withPush = makeDeps(true);
  await notifyMatchFound(withPush.deps);
  assert.ok(!withPush.calls.includes('sendEmailFallback'), 'Con push activo, no debe llamarse el fallback de email.');

  const withoutPush = makeDeps(false);
  await notifyMatchFound(withoutPush.deps);
  assert.ok(!withoutPush.calls.includes('sendPush'), 'Sin push activo, no debe llamarse sendPush.');
});

test('notifyMatchFound - propaga un error si sendPush falla', async () => {
  const deps = {
    hasActivePush: async () => true,
    sendPush: async () => { throw new Error('fallo simulado de push'); },
    sendEmailFallback: async () => true
  };

  await assert.rejects(() => notifyMatchFound(deps), /fallo simulado de push/);
});
