// KAN-40: envio de notificaciones web push puntuales, fuera del ciclo periodico de notifier.ts.
// Reusa el mismo mecanismo ya cableado por POST /api/notifications/subscribe
// (web_push_subscriptions + VAPID, ver src/index.ts), sin depender de WhatsApp/Baileys.

import webpush from 'web-push';
import { supabase } from './supabase';
import { config } from '../config/env';
import { logger } from './logger';

webpush.setVapidDetails(config.vapidEmail, config.vapidPublicKey, config.vapidPrivateKey);

export async function sendWebPushToTenant(tenantId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { data: subs, error } = await supabase
      .from('web_push_subscriptions')
      .select('id, subscription')
      .eq('tenant_id', tenantId);

    if (error) throw error;
    if (!subs || subs.length === 0) return;

    const serialized = JSON.stringify(payload);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub.subscription as any, serialized);
      } catch (pushErr: any) {
        if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
          logger.info({ subId: sub.id, statusCode: pushErr.statusCode }, '[WEBPUSH] Eliminando suscripción web push expirada/inválida.');
          await supabase.from('web_push_subscriptions').delete().eq('id', sub.id);
        } else {
          logger.error({ error: pushErr.message || pushErr, subId: sub.id }, '[WEBPUSH] Error al enviar notificación web push individual.');
        }
      }
    }
  } catch (err: any) {
    logger.error({ error: err.message || err, tenantId }, '[WEBPUSH] Error al procesar notificaciones web push para el tenant.');
  }
}
