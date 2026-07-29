// KAN-40: envio de notificaciones web push puntuales, fuera del ciclo periodico de notifier.ts.
// Reusa el mismo mecanismo ya cableado por POST /api/notifications/subscribe
// (web_push_subscriptions + VAPID, ver src/index.ts), sin depender de WhatsApp/Baileys.

import webpush from 'web-push';
import { supabase } from './supabase';
import { config } from '../config/env';
import { logger } from './logger';

webpush.setVapidDetails(config.vapidEmail, config.vapidPublicKey, config.vapidPrivateKey);

// KAN-45: texto minimizado y fijo (no depende del conteo de matches ni de datos de la propiedad)
// para que la notificación nunca filtre dirección/precio/contacto por un canal sin control de
// acceso propio, sin importar quién la dispare.
export function buildMatchFoundPushPayload(searchId: string): Record<string, unknown> {
  return {
    title: 'Matchouse',
    body: 'Tenés un match nuevo — tocá para ver',
    tag: `search-match-${searchId}`,
    data: { url: '/' }
  };
}

// KAN-48: usado para decidir si el email de respaldo debe dispararse (solo cuando el tenant NO
// tiene push activo, así los dos canales no se duplican para un mismo evento). Ante un error de
// red/DB, se devuelve false a propósito (fail-open hacia el email): es preferible arriesgar un
// email de más que perder el aviso por completo si este chequeo puntual falla.
export async function hasActivePushSubscriptions(tenantId: string, client = supabase): Promise<boolean> {
  const { count, error } = await client
    .from('web_push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (error) {
    logger.error({ error: error.message, tenantId }, '[WEBPUSH] Error al chequear suscripciones activas del tenant.');
    return false;
  }

  return (count || 0) > 0;
}

export async function sendWebPushToTenant(tenantId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { data: subs, error } = await supabase
      .from('web_push_subscriptions')
      .select('id, subscription')
      .eq('tenant_id', tenantId);

    if (error) throw error;
    if (!subs || subs.length === 0) {
      logger.info({ tenantId }, '[WEBPUSH] Sin suscripciones activas para el tenant, no se envía ninguna notificación.');
      return;
    }

    const serialized = JSON.stringify(payload);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub.subscription as any, serialized);
        logger.info({ subId: sub.id, tenantId }, '[WEBPUSH] Notificación push entregada exitosamente.');
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
