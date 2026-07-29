import test from 'node:test';
import assert from 'node:assert';
import { calculateDaysRemaining } from '../src/utils/activeSearches';

test('activeSearches.calculateDaysRemaining - redondea hacia arriba dentro del mismo día', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');
  const expiresAt = new Date('2026-07-29T12:30:00.000Z'); // 30 minutos despues
  assert.strictEqual(calculateDaysRemaining(expiresAt, now), 1);
});

test('activeSearches.calculateDaysRemaining - calcula dias completos exactos', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');
  const expiresAt = new Date('2026-08-05T12:00:00.000Z'); // 7 dias exactos
  assert.strictEqual(calculateDaysRemaining(expiresAt, now), 7);
});

test('activeSearches.calculateDaysRemaining - nunca devuelve negativo para busquedas ya vencidas', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');
  const expiresAt = new Date('2026-07-20T12:00:00.000Z'); // ya vencio
  assert.strictEqual(calculateDaysRemaining(expiresAt, now), 0);
});

test('activeSearches.calculateDaysRemaining - acepta expires_at como string ISO (formato real de Supabase)', () => {
  const now = new Date('2026-07-29T12:00:00.000Z');
  assert.strictEqual(calculateDaysRemaining('2026-07-30T12:00:00.000Z', now), 1);
});

test('activeSearches.calculateDaysRemaining - default de "now" es la hora actual real', () => {
  const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(calculateDaysRemaining(future), 2);
});
