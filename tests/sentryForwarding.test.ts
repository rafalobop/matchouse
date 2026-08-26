import test from 'node:test';
import assert from 'node:assert';
import { decideSentryForwarding, extractLogPayloadForSentry } from '../src/utils/sentryForwarding';

test('KAN-83 - decideSentryForwarding: info/debug/trace no se reenvían a Sentry', () => {
  assert.strictEqual(decideSentryForwarding(30), null); // info
  assert.strictEqual(decideSentryForwarding(20), null); // debug
  assert.strictEqual(decideSentryForwarding(10), null); // trace
});

test('KAN-83 - decideSentryForwarding: warn (40) es "low"/"warning" — resumen periódico', () => {
  const decision = decideSentryForwarding(40);
  assert.deepStrictEqual(decision, { severity: 'low', sentryLevel: 'warning' });
});

test('KAN-83 - decideSentryForwarding: error (50) es "critical"/"error" — alerta inmediata', () => {
  const decision = decideSentryForwarding(50);
  assert.deepStrictEqual(decision, { severity: 'critical', sentryLevel: 'error' });
});

test('KAN-83 - decideSentryForwarding: fatal (60) es "critical"/"fatal" — alerta inmediata', () => {
  const decision = decideSentryForwarding(60);
  assert.deepStrictEqual(decision, { severity: 'critical', sentryLevel: 'fatal' });
});

test('KAN-83 - extractLogPayloadForSentry: extrae el mensaje de texto plano', () => {
  const { message, error, context } = extractLogPayloadForSentry(['[AUTH] Sesión inválida']);
  assert.strictEqual(message, '[AUTH] Sesión inválida');
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(context, {});
});

test('KAN-83 - extractLogPayloadForSentry: extrae un Error real pasado como primer argumento', () => {
  const err = new Error('fallo real');
  const { error, message } = extractLogPayloadForSentry([err]);
  assert.strictEqual(error, err);
  assert.strictEqual(message, undefined);
});

test('KAN-83 - extractLogPayloadForSentry: extrae un Error anidado dentro del objeto de contexto (patrón real del repo)', () => {
  const err = new Error('fallo de supabase');
  const { error, context } = extractLogPayloadForSentry([{ tenantId: 'tenant-1', err }, '[MATCHES] Error al recuperar matches']);
  assert.strictEqual(error, err);
  assert.strictEqual(context.tenantId, 'tenant-1');
  assert.ok(!('err' in context), 'El Error no debe duplicarse dentro de context.');
});

test('KAN-83 - extractLogPayloadForSentry: filtra los campos de PII_LOG_FIELDS del contexto (KAN-135)', () => {
  const { context } = extractLogPayloadForSentry([
    { tenantId: 'tenant-1', email: 'juan@example.com', ip: '1.2.3.4', address: 'Calle Falsa 123', texto: 'busco depto' },
    'mensaje'
  ]);
  assert.deepStrictEqual(context, { tenantId: 'tenant-1' });
  assert.ok(!('email' in context));
  assert.ok(!('ip' in context));
  assert.ok(!('address' in context));
  assert.ok(!('texto' in context));
});

test('KAN-83 - extractLogPayloadForSentry: sin ningún argumento devuelve context vacío y sin error/message', () => {
  const { error, message, context } = extractLogPayloadForSentry([]);
  assert.strictEqual(error, undefined);
  assert.strictEqual(message, undefined);
  assert.deepStrictEqual(context, {});
});
