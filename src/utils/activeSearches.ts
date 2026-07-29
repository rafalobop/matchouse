// KAN-39: helper puro para GET /api/searches. Separado de src/index.ts por el mismo motivo que
// searchValidation.ts (ese archivo arranca el servidor completo al importarse, no se puede
// importar desde tests).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Días restantes hasta expires_at, redondeados hacia arriba (un search que vence en 30 minutos
 * cuenta como "1 día restante", no "0"). Nunca negativo: un search ya vencido reporta 0.
 */
export function calculateDaysRemaining(expiresAt: string | Date, now: Date = new Date()): number {
  const expiresAtMs = new Date(expiresAt).getTime();
  const diffMs = expiresAtMs - now.getTime();
  return Math.max(0, Math.ceil(diffMs / MS_PER_DAY));
}
