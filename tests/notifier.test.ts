import test from 'node:test';
import assert from 'node:assert';
import { sendConsolidatedNotifications, startNotificationService } from '../src/services/notifier';

test('Notifier Service - Debería exponer funciones de inicio y envío consolidado', () => {
  assert.strictEqual(typeof sendConsolidatedNotifications, 'function', 'sendConsolidatedNotifications debe ser una función.');
  assert.strictEqual(typeof startNotificationService, 'function', 'startNotificationService debe ser una función.');
});

test('Web Push - Debería tener configurado VAPID correctamente', () => {
  const { config } = require('../src/config/env');
  assert.ok(config.vapidPublicKey, 'VAPID public key debe estar definida.');
  assert.ok(config.vapidPrivateKey, 'VAPID private key debe estar definida.');
  assert.ok(config.vapidEmail, 'VAPID email debe estar definido.');
});
