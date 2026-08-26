// KAN-40: envio de notificaciones web push puntuales, fuera del ciclo periodico de notifier.ts.
// Reusa el mismo mecanismo ya cableado por POST /api/notifications/subscribe
// (web_push_subscriptions + VAPID, ver src/index.ts), sin depender de WhatsApp/Baileys.

import webpush from 'web-push';
import { supabase } from './supabase';
import { config } from '../config/env';
import { logger } from './logger';

webpush.setVapidDetails(config.vapidEmail, config.vapidPublicKey, config.vapidPrivateKey);

// KAN-78: aviso al dueño de la propiedad matcheada de que un agente la buscó — único lado que se
// notifica de este evento (decisión de producto, 2026-08-21: el buscador ya no recibe push/email
// de sus propios matches, ver src/routes/search.ts). Texto genérico y fijo, sin datos del
// buscador (nombre/teléfono/inmobiliaria) por un canal sin control de acceso propio; el detalle
// completo va solo por email/dashboard autenticado (GET /api/matches/incoming).
//
// KAN-303: `data.url` ya no es '/' fijo — apunta a la página de matches entrantes del frontend
// (`brokaza-frontend`, ruta real de Next.js `/matches`, no una sección por hash — ese era el
// esquema del dashboard legacy servido por este mismo repo, retirado en KAN-258) con los ids de
// blind_matches recién insertados en `?highlight=` para que `MatchesPage`/`IncomingMatchesSection`
// resalten esas filas al entrar. matchRowIds son los ids reales de fila (blind_matches.id), no el
// search_id — sin esto el frontend no tiene forma de saber qué fila puntual resaltar.
export function buildIncomingMatchPushPayload(matchRowIds: string | (string | null)[]): Record<string, unknown> {
  const ids = (Array.isArray(matchRowIds) ? matchRowIds : [matchRowIds]).filter((id): id is string => Boolean(id));
  const tagId = ids[0] || 'unknown';
  return {
    title: 'Brokaza',
    body: 'Un agente busca una propiedad como una de las tuyas — tocá para ver',
    tag: `incoming-match-${tagId}`,
    data: { url: `/matches?highlight=${encodeURIComponent(ids.join(','))}` }
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

// KAN-79: devuelve un booleano de éxito (antes: void) para que notifyMatchFound
// (services/notifications.ts) pueda distinguir un fallo real de una entrega exitosa y aplicar
// retry — sin este cambio, el try/catch interno ya existente absorbía cualquier fallo en
// silencio y un wrapper de reintentos por afuera nunca se enteraba de que había algo que
// reintentar. No cambia ningún log ni el manejo por-suscripción ya existente (limpieza de
// suscripciones expiradas en 410/404 sigue igual, no cuenta como fallo reintentable).
export async function sendWebPushToTenant(tenantId: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const { data: subs, error } = await supabase
      .from('web_push_subscriptions')
      .select('id, subscription')
      .eq('tenant_id', tenantId);

    if (error) throw error;
    if (!subs || subs.length === 0) {
      logger.info({ tenantId }, '[WEBPUSH] Sin suscripciones activas para el tenant, no se envía ninguna notificación.');
      return true;
    }

    let allDelivered = true;
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
          allDelivered = false;
        }
      }
    }
    return allDelivered;
  } catch (err: any) {
    logger.error({ error: err.message || err, tenantId }, '[WEBPUSH] Error al procesar notificaciones web push para el tenant.');
    return false;
  }
}
