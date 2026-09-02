// KAN-306: reintento periódico de validación de matrícula para cuentas en estado 'pending' —
// contraparte de resolveLicenseValidationStatus (licenseRegistry.ts), que decide 'pending' cuando
// el padrón está desactualizado al momento del registro (AC5, registro temporal). Mismo patrón de
// loop en segundo plano ya establecido (searchExpiration.ts/reengagement.ts), wireado en main().

import { supabase } from './supabase';
import { logger } from './logger';
import { config } from '../config/env';
import { syncLicensedAgents, resolveLicenseValidationStatus } from './licenseRegistry';
import { sendWebPushToTenant } from './webPush';

export interface LicenseValidationRetryResult {
  validated: string[];
  rejected: string[];
}

export async function runLicenseValidationRetry(client = supabase): Promise<LicenseValidationRetryResult> {
  // Best-effort: si el scraping falla acá, `resolveLicenseValidationStatus` de abajo va a seguir
  // viendo la caché vieja (o vacía) y todo perfil pendiente se queda en 'pending' esta corrida,
  // sin lanzar — mismo criterio fail-safe de syncLicensedAgents.
  await syncLicensedAgents(client);

  const { data: pendingProfiles, error } = await client
    .from('profiles')
    .select('id, license_number')
    .eq('license_validation_status', 'pending')
    .not('license_number', 'is', null);

  if (error) {
    logger.error({ error: error.message }, '[LICENSE-RETRY] Error al leer perfiles pendientes de validación.');
    throw error;
  }

  const validated: string[] = [];
  const rejected: string[] = [];

  for (const profile of pendingProfiles || []) {
    const status = await resolveLicenseValidationStatus(profile.license_number as string, client);
    if (status === 'pending') continue; // el padrón sigue desactualizado; se reintenta en la próxima corrida

    const { error: updateError } = await client
      .from('profiles')
      .update({ license_validation_status: status, profile_completed: status === 'validated' })
      .eq('id', profile.id);

    if (updateError) {
      logger.error({ error: updateError.message, tenantId: profile.id }, '[LICENSE-RETRY] Error al actualizar el estado de validación.');
      continue;
    }

    if (status === 'validated') {
      validated.push(profile.id);
    } else {
      rejected.push(profile.id);
    }

    const payload = status === 'validated'
      ? { title: 'Matchouse', body: 'Tu matrícula fue validada — ya podés usar la plataforma.', tag: `license-validated-${profile.id}`, data: { url: '/' } }
      : { title: 'Matchouse', body: 'No pudimos validar tu número de matrícula. Revisalo e intentá de nuevo desde tu perfil.', tag: `license-rejected-${profile.id}`, data: { url: '/' } };
    sendWebPushToTenant(profile.id as string, payload).catch((err: any) => {
      logger.error({ error: err.message || err, tenantId: profile.id }, '[LICENSE-RETRY] Error al enviar la notificación de resultado de validación.');
    });
  }

  if (validated.length > 0 || rejected.length > 0) {
    logger.info({ validated: validated.length, rejected: rejected.length }, '[LICENSE-RETRY] Reintento de validación de matrícula completado.');
  }

  return { validated, rejected };
}

let retryInterval: NodeJS.Timeout | null = null;

/**
 * Arranca el loop periódico. Además dispara una sincronización inicial del padrón sin esperar al
 * primer intervalo (fire-and-forget) — sin esto, `licensed_agents` queda vacía (padrón "caído" por
 * definición) durante todo el primer intervalo tras cada deploy/reinicio, lo que forzaría a
 * `'pending'` cualquier registro real que llegue en esa ventana.
 */
export function startLicenseValidationRetryService(): void {
  const intervalMs = config.licenseValidationRetryIntervalMinutes * 60 * 1000;
  logger.info(
    { intervalMinutes: config.licenseValidationRetryIntervalMinutes },
    '[LICENSE-RETRY] Iniciando servicio de reintento de validación de matrícula (KAN-306).'
  );

  // syncLicensedAgents nunca lanza (loguea y devuelve false ante cualquier fallo) — no hace falta
  // un .catch acá.
  void syncLicensedAgents();

  retryInterval = setInterval(() => {
    runLicenseValidationRetry().catch((err: any) => {
      logger.error({ error: err.message || err }, '[LICENSE-RETRY] Fallo inesperado en la corrida periódica.');
    });
  }, intervalMs);
}

export function stopLicenseValidationRetryService(): void {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
}
