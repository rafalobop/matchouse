// KAN-58: mensaje de reenganche ("¿la renovás?") para active_searches que vencieron (KAN-41,
// status='expired') sin haber recibido nunca un match. Igual que KAN-41, el ticket describe un
// cron externo que no aplica a este repo (100% Node/TS) — mismo patrón ya establecido de servicio
// en segundo plano con setInterval (searchExpiration.ts, notifier-email.ts, dolar.ts).
//
// "Sin match" se resuelve contra `blind_matches.search_id` (dirección cartera→búsqueda, KAN-79):
// es la única persistencia real que relaciona una búsqueda con un match — la dirección
// búsqueda→cartera (KAN-37) nunca persiste sus matches, así que no hay forma de saber desde
// active_searches sola si tuvo resultados en el momento de la creación.
//
// Duplicados: nueva columna `active_searches.reengagement_sent` (boolean, default false, migración
// `kan58_add_reengagement_sent_to_active_searches`) — el flag pedido explícitamente por el AC.

import { supabase } from './supabase';
import { logger } from './logger';
import { config } from '../config/env';
import { withRetry } from '../utils/withRetry';
import { hasActivePushSubscriptions, sendWebPushToTenant, buildReengagementPushPayload } from './webPush';
import { sendReengagementEmail } from './notifier-email';

export interface ReengagementCandidate {
  id: string;
  tenant_id: string;
  raw_text: string;
}

export interface ReengagementDeps {
  hasActivePush: (tenantId: string) => Promise<boolean>;
  sendPush: (tenantId: string, searchId: string) => Promise<boolean | void>;
  sendEmailFallback: (tenantId: string, rawText: string) => Promise<boolean>;
}

const defaultDeps: ReengagementDeps = {
  hasActivePush: hasActivePushSubscriptions,
  sendPush: (tenantId, searchId) => sendWebPushToTenant(tenantId, buildReengagementPushPayload(searchId)),
  sendEmailFallback: sendReengagementEmail
};

async function sendWithRetry(action: () => Promise<boolean | void>): Promise<void> {
  await withRetry(async () => {
    const result = await action();
    if (result === false) {
      throw new Error('La acción de notificación no tuvo éxito (reintentable)');
    }
  }, { attempts: 3, baseDelayMs: 150 });
}

/**
 * Busca las active_searches 'expired' con el flag de reenganche todavía apagado, y descarta las
 * que sí tuvieron algún match persistido en blind_matches (dirección cartera→búsqueda).
 */
export async function findReengagementCandidates(client = supabase): Promise<ReengagementCandidate[]> {
  const { data: expiredRows, error: expiredError } = await client
    .from('active_searches')
    .select('id, tenant_id, raw_text')
    .eq('status', 'expired')
    .eq('reengagement_sent', false);

  if (expiredError) {
    logger.error({ error: expiredError.message || expiredError }, '[REENGAGEMENT] Error al leer active_searches vencidas sin reenganche enviado.');
    throw expiredError;
  }

  const rows = expiredRows || [];
  if (rows.length === 0) return [];

  const { data: matchedRows, error: matchedError } = await client
    .from('blind_matches')
    .select('search_id')
    .in('search_id', rows.map((r: any) => r.id));

  if (matchedError) {
    logger.error({ error: matchedError.message || matchedError }, '[REENGAGEMENT] Error al leer blind_matches para descartar búsquedas ya matcheadas.');
    throw matchedError;
  }

  const matchedIds = new Set((matchedRows || []).map((r: any) => r.search_id));
  return rows.filter((r: any) => !matchedIds.has(r.id));
}

/**
 * Corrida periódica: envía el aviso de reenganche (push si hay suscripción activa, si no email de
 * respaldo — mismo criterio de exclusión mutua que notifyMatchFound, KAN-48) a cada candidata, y
 * marca reengagement_sent=true solo tras un envío exitoso, para no perder el aviso si el envío
 * falla tras los reintentos.
 */
export async function runReengagementMessages(client = supabase, deps: ReengagementDeps = defaultDeps): Promise<{ processed: number; sent: number; failed: number }> {
  const candidates = await findReengagementCandidates(client);

  let sent = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const hasPush = await deps.hasActivePush(candidate.tenant_id);
      if (hasPush) {
        await sendWithRetry(() => deps.sendPush(candidate.tenant_id, candidate.id));
      } else {
        await sendWithRetry(() => deps.sendEmailFallback(candidate.tenant_id, candidate.raw_text));
      }

      const { error: updateError } = await client
        .from('active_searches')
        .update({ reengagement_sent: true })
        .eq('id', candidate.id);

      if (updateError) throw updateError;
      sent++;
    } catch (err: any) {
      failed++;
      logger.error({ error: err.message || err, searchId: candidate.id, tenantId: candidate.tenant_id }, '[REENGAGEMENT] Fallo al enviar (o registrar) el aviso de reenganche de una búsqueda.');
    }
  }

  logger.info({ processed: candidates.length, sent, failed }, '[REENGAGEMENT] Corrida de avisos de reenganche finalizada.');
  return { processed: candidates.length, sent, failed };
}

let reengagementInterval: NodeJS.Timeout | null = null;

export function startReengagementService(): void {
  const intervalMs = config.reengagementIntervalMinutes * 60 * 1000;
  logger.info(
    { intervalMinutes: config.reengagementIntervalMinutes },
    '[REENGAGEMENT] Iniciando servicio de avisos de reenganche (KAN-58).'
  );

  reengagementInterval = setInterval(() => {
    runReengagementMessages().catch((err: any) => {
      logger.error({ error: err.message || err }, '[REENGAGEMENT] Fallo inesperado en la corrida periódica.');
    });
  }, intervalMs);
}

export function stopReengagementService(): void {
  if (reengagementInterval) {
    clearInterval(reengagementInterval);
    reengagementInterval = null;
  }
}
