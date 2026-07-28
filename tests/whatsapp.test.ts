import test from 'node:test';
import assert from 'node:assert';
import { activeSessions, sessionStatuses, initTenantSession, logoutTenantSession } from '../src/services/whatsapp';
import { validateConfig } from '../src/config/env';

test('WhatsApp Service - Debería estar listo para administrar sesiones y hooks', () => {
  assert.ok(activeSessions, 'El mapa activeSessions debe estar definido.');
  assert.ok(sessionStatuses, 'El mapa sessionStatuses debe estar definido.');
  assert.strictEqual(typeof initTenantSession, 'function', 'initTenantSession debe ser una función.');
  assert.strictEqual(typeof logoutTenantSession, 'function', 'logoutTenantSession debe ser una función.');
});

test('WhatsApp Service - BAILEYS_FROZEN (KAN-32) congela por default y respeta override explícito', () => {
  const originalValue = process.env.BAILEYS_FROZEN;
  try {
    delete process.env.BAILEYS_FROZEN;
    const defaultConfig = validateConfig();
    assert.strictEqual(defaultConfig.baileysFrozen, true, 'Sin la variable definida, Baileys debe seguir congelado por default (KAN-32).');

    process.env.BAILEYS_FROZEN = 'false';
    const unfrozenConfig = validateConfig();
    assert.strictEqual(unfrozenConfig.baileysFrozen, false, 'Con BAILEYS_FROZEN=false explícito, el congelamiento debe desactivarse.');

    process.env.BAILEYS_FROZEN = 'true';
    const explicitFrozenConfig = validateConfig();
    assert.strictEqual(explicitFrozenConfig.baileysFrozen, true, 'Con BAILEYS_FROZEN=true explícito, debe seguir congelado.');
  } finally {
    if (originalValue === undefined) {
      delete process.env.BAILEYS_FROZEN;
    } else {
      process.env.BAILEYS_FROZEN = originalValue;
    }
  }
});
