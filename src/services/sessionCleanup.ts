import { Resend } from 'resend';
import { activeSessions, logoutTenantSession } from './whatsapp';
import { logger } from './logger';
import { config } from '../config/env';

const FROM_ADDRESS = 'HouseMatch <onboarding@resend.dev>';

let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!resendClient) {
    if (!config.resendApiKey) {
      throw new Error('Falta SENDER_API_KEY (Resend) para notificar la desconexión de sesiones de prueba.');
    }
    resendClient = new Resend(config.resendApiKey);
  }
  return resendClient;
}

/**
 * Permite inyectar un cliente mock en tests para no mandar emails reales.
 */
export function __setResendClientForTests(client: any): void {
  resendClient = client;
}

/**
 * De la lista de tenants configurados como "de prueba" (TEST_WHATSAPP_TENANT_IDS),
 * cuáles tienen hoy una sesión de WhatsApp activa en memoria y deben desconectarse.
 * Es una allowlist explícita, no una heurística: solo toca tenants que el equipo
 * marcó a mano como de prueba (KAN-53).
 */
export function selectTestSessionsToDisconnect(activeTenantIds: string[], testTenantIds: string[]): string[] {
  const activeSet = new Set(activeTenantIds);
  return testTenantIds.filter(id => activeSet.has(id));
}

async function notifyDisconnections(tenantIds: string[]): Promise<void> {
  logger.warn({ tenantIds }, '[SESSION-CLEANUP] Sesiones de WhatsApp de prueba desconectadas (KAN-53).');

  if (!config.resendApiKey || !config.devAlertEmail) {
    logger.info('[SESSION-CLEANUP] SENDER_API_KEY o DEV_ALERT_EMAIL no configurados: la notificación queda solo en los logs.');
    return;
  }

  try {
    const resend = getResendClient();
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: config.devAlertEmail,
      subject: `HouseMatch: ${tenantIds.length} sesión(es) de WhatsApp de prueba desconectada(s)`,
      html: `<p>Se desconectaron automáticamente las siguientes sesiones de WhatsApp de prueba (KAN-53):</p><ul>${tenantIds.map(id => `<li>${id}</li>`).join('')}</ul>`
    });

    if (result.error) {
      logger.error({ error: result.error }, '[SESSION-CLEANUP] Resend devolvió un error al notificar la desconexión.');
    }
  } catch (err: any) {
    logger.error({ error: err.message || err }, '[SESSION-CLEANUP] Error al notificar por email la desconexión de sesiones de prueba.');
  }
}

/**
 * Desconecta las sesiones de WhatsApp activas que correspondan a tenants marcados como
 * de prueba (TEST_WHATSAPP_TENANT_IDS) y notifica a devs/testers del resultado.
 */
export async function runTestSessionCleanup(): Promise<string[]> {
  const toDisconnect = selectTestSessionsToDisconnect(
    Array.from(activeSessions.keys()),
    config.testWhatsappTenantIds
  );

  if (toDisconnect.length === 0) return [];

  for (const tenantId of toDisconnect) {
    try {
      await logoutTenantSession(tenantId);
      logger.warn({ tenantId }, '[SESSION-CLEANUP] Sesión de prueba desconectada.');
    } catch (err: any) {
      logger.error({ tenantId, error: err.message || err }, '[SESSION-CLEANUP] Error al desconectar sesión de prueba.');
    }
  }

  await notifyDisconnections(toDisconnect);
  return toDisconnect;
}

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Inicia el loop en segundo plano de desconexión de sesiones de WhatsApp de prueba (KAN-53).
 * Si no hay tenants de prueba configurados, el servicio queda inactivo (no hace polling en vano).
 */
export function startSessionCleanupService(): void {
  if (config.testWhatsappTenantIds.length === 0) {
    logger.info('[SESSION-CLEANUP] TEST_WHATSAPP_TENANT_IDS vacío: servicio de desconexión de sesiones de prueba inactivo.');
    return;
  }

  const intervalMs = config.sessionCleanupIntervalMinutes * 60 * 1000;
  logger.info(
    { intervalMinutes: config.sessionCleanupIntervalMinutes, testTenants: config.testWhatsappTenantIds.length },
    '[SESSION-CLEANUP] Iniciando servicio de desconexión de sesiones de WhatsApp de prueba (KAN-53).'
  );

  cleanupInterval = setInterval(() => {
    runTestSessionCleanup();
  }, intervalMs);
}

export function stopSessionCleanupService(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
