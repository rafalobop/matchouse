// KAN-41: vencimiento de active_searches sin match a los 7 días. El ticket original lo describe
// como un cron externo ("search_expiration_cron.py") - no aplica a este repo (100% Node/TS, sin
// runtime de Python ni infra de cron externa). Sigue el mismo patrón ya establecido para trabajos
// periódicos en este proyecto (sessionCleanup.ts, notifier-email.ts, dolar.ts): un servicio en
// segundo plano con setInterval, wireado en main() (src/index.ts).
//
// El ticket también pide marcar el status como 'EXPIRED' (mayúscula) - igual que el drift ya
// corregido en KAN-38, el CHECK constraint real de active_searches.status solo acepta minúsculas
// ('active'/'expired'/'matched'/'cancelled'), así que este código persiste 'expired'.

import { supabase } from './supabase';
import { logger } from './logger';
import { config } from '../config/env';
import { createIntervalService } from '../utils/intervalService';

/**
 * Marca como 'expired' toda active_searches con status 'active' cuyo expires_at ya pasó.
 * Las búsquedas 'matched'/'cancelled'/ya 'expired' quedan afuera por el propio filtro de status,
 * sin necesidad de excluirlas explícitamente. Devuelve los IDs marcados (para logging/tests).
 */
export async function runSearchExpiration(client = supabase): Promise<string[]> {
  const { data, error } = await client
    .from('active_searches')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('expires_at', new Date().toISOString())
    .select('id');

  if (error) {
    logger.error({ error: error.message || error }, '[SEARCH-EXPIRATION] Error al marcar búsquedas vencidas.');
    throw error;
  }

  const expiredIds = (data || []).map((row: any) => row.id);
  if (expiredIds.length > 0) {
    logger.info({ count: expiredIds.length, expiredIds }, '[SEARCH-EXPIRATION] Búsquedas marcadas como expired.');
  }
  return expiredIds;
}

const expirationIntervalService = createIntervalService({
  label: 'SEARCH-EXPIRATION',
  intervalMs: config.searchExpirationIntervalMinutes * 60 * 1000,
  task: () => runSearchExpiration()
});

/**
 * Inicia el loop en segundo plano de vencimiento de búsquedas (KAN-41).
 */
export function startSearchExpirationService(): void {
  logger.info(
    { intervalMinutes: config.searchExpirationIntervalMinutes },
    '[SEARCH-EXPIRATION] Iniciando servicio de vencimiento de búsquedas (KAN-41).'
  );

  expirationIntervalService.start();
}

export function stopSearchExpirationService(): void {
  expirationIntervalService.stop();
}
