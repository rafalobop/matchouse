import { supabase } from './supabase';
import { activeSessions, sendWhatsAppMessage } from './whatsapp';
import { logger } from './logger';
import webpush from 'web-push';
import { config } from '../config/env';

// Configurar Web Push
webpush.setVapidDetails(
  config.vapidEmail,
  config.vapidPublicKey,
  config.vapidPrivateKey
);

// Historial para evitar repeticiones consecutivas de plantillas por Tenant
const lastTemplateIndex = new Map<string, number>();

// Definición de las 5 plantillas de mensaje
const TEMPLATES = [
  // Plantilla 1
  (groupName: string, originalText: string, sender: string, senderPhone: string, propDetails: string) => 
`🏠 *¡HOUSEMATCH: MATCHES DETECTADOS!* 🏠

En el grupo: _${groupName}_
💬 *Pedido:* "${originalText.substring(0, 150)}${originalText.length > 150 ? '...' : ''}"
👤 *Cliente:* ${sender} (wa.me/${senderPhone})

💡 *Propiedades Coincidentes:*
${propDetails}

_Revisa y gestiona estos matches desde tu Dashboard._`,

  // Plantilla 2
  (groupName: string, originalText: string, sender: string, senderPhone: string, propDetails: string) => 
`🔍 *¡ALERTA DE PROPIEDAD ENCONTRADA!* 🔍

¡Hola! Encontramos propiedades para el pedido del grupo _${groupName}_:
💬 *Pedido:* "${originalText.substring(0, 150)}${originalText.length > 150 ? '...' : ''}"
👤 *Cliente:* ${sender} (wa.me/${senderPhone})

🔑 *Oportunidades de Cartera:*
${propDetails}

_Accede al Dashboard para contactar al captador._`,

  // Plantilla 3
  (groupName: string, originalText: string, sender: string, senderPhone: string, propDetails: string) => 
`💼 *RESUMEN DE COINCIDENCIAS - HOUSEMATCH* 💼

Hola, el sistema detectó nuevos matches en el grupo _${groupName}_:
💬 *Pedido:* "${originalText.substring(0, 150)}${originalText.length > 150 ? '...' : ''}"
👤 *Cliente:* ${sender} (wa.me/${senderPhone})

📋 *Lista de Opciones:*
${propDetails}

_Recuerda registrar tu feedback en el Dashboard._`,

  // Plantilla 4
  (groupName: string, originalText: string, sender: string, senderPhone: string, propDetails: string) => 
`⚡ *NUEVA COINCIDENCIA DE CARTERA* ⚡

¡Buenas noticias! Localizamos propiedades para el pedido en _${groupName}_:
💬 *Pedido:* "${originalText.substring(0, 150)}${originalText.length > 150 ? '...' : ''}"
👤 *Cliente:* ${sender} (wa.me/${senderPhone})

✨ *Propiedades Compatibles:*
${propDetails}

_Toda la información ya está disponible en tu Dashboard._`,

  // Plantilla 5
  (groupName: string, originalText: string, sender: string, senderPhone: string, propDetails: string) => 
`📊 *REPORTE DE MATCHES CALIFICADOS* 📊

Hola. El Agente Validador aprobó las siguientes opciones para el pedido en _${groupName}_:
💬 *Pedido:* "${originalText.substring(0, 150)}${originalText.length > 150 ? '...' : ''}"
👤 *Cliente:* ${sender} (wa.me/${senderPhone})

🎯 *Coincidencias:*
${propDetails}

_Conéctate al Dashboard para realizar la curación final._`
];

/**
 * Selecciona una plantilla aleatoria para el Tenant asegurando que no se repita consecutivamente
 */
function getTemplateForTenant(tenantId: string): typeof TEMPLATES[number] {
  const lastIdx = lastTemplateIndex.get(tenantId);
  let newIdx = Math.floor(Math.random() * TEMPLATES.length);

  // Si coincide con el último, elegir el siguiente índice de forma circular
  if (lastIdx !== undefined && newIdx === lastIdx) {
    newIdx = (newIdx + 1) % TEMPLATES.length;
  }

  lastTemplateIndex.set(tenantId, newIdx);
  return TEMPLATES[newIdx];
}

/**
 * Envía un único mensaje de WhatsApp consolidado con todos los matches de un mismo mensaje
 * (mismo remitente + mismo texto) y marca esos matches como notificados. Se usa tanto para el
 * envío inmediato (disparado apenas el coordinador termina de procesar un mensaje) como para el
 * ciclo de respaldo que reintenta matches que quedaron pendientes por algún error transitorio.
 */
export async function sendWhatsAppForMatchGroup(tenantId: string, matchGroup: any[]): Promise<boolean> {
  if (!matchGroup || matchGroup.length === 0) return false;

  const sock = activeSessions.get(tenantId);
  if (!sock || !sock.user?.id) {
    logger.warn({ tenantId }, '[NOTIFIER] Tenant no tiene sesión de WhatsApp activa o conectada. Omitiendo.');
    return false;
  }

  const firstMatch = matchGroup[0];
  const groupName = firstMatch.whatsapp_group_name;
  const originalText = firstMatch.raw_message_text;
  const sender = firstMatch.whatsapp_sender_name;
  const senderPhone = firstMatch.whatsapp_sender_phone;
  const messageKey = `${senderPhone}|${originalText}`;

  // Construir detalles de las propiedades
  const propDetails = matchGroup.map((m, idx) => {
    const prop = m.property;
    const waLink = prop.contact_info ? `https://wa.me/${prop.contact_info.replace(/\D/g, '')}` : '';
    const contactInfo = waLink ? `[${prop.contact_info}](${waLink})` : (prop.contact_info || 'No especificado');

    return `*${idx + 1}. ${prop.address}* (${prop.sheet_name})
   • Precio: *${prop.currency} ${prop.price}*
   • Zona: ${prop.sheet_name}
   • Contacto Captador: ${contactInfo}`;
  }).join('\n\n');

  // Seleccionar plantilla rotativa
  const templateFn = getTemplateForTenant(tenantId);
  const consolidatedMessage = templateFn(groupName, originalText, sender, senderPhone, propDetails);

  try {
    // Simulación de escritura humana antes del envío
    const selfJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    await sock.sendPresenceUpdate('composing', selfJid);
    // Retraso aleatorio de simulación entre 2 y 4 segundos
    const delayTime = 2000 + Math.floor(Math.random() * 2000);
    await new Promise(resolve => setTimeout(resolve, delayTime));

    // Enviar mensaje
    await sock.sendMessage(selfJid, { text: consolidatedMessage });
    logger.info({ tenantId, messageKey, matchCount: matchGroup.length }, '[NOTIFIER] Mensaje consolidado enviado con éxito.');

    // Enviar Web Push Notification
    try {
      const { data: subs, error: subsError } = await supabase
        .from('web_push_subscriptions')
        .select('id, subscription')
        .eq('tenant_id', tenantId);

      if (subsError) throw subsError;

      if (subs && subs.length > 0) {
        const payload = JSON.stringify({
          title: `🏠 Match Detectado - ${groupName}`,
          body: `Se encontraron propiedades coincidentes para el pedido de ${sender}.`,
          tag: `match-${messageKey}`,
          data: {
            url: '/'
          }
        });

        for (const sub of subs) {
          try {
            await webpush.sendNotification(sub.subscription as any, payload);
          } catch (pushErr: any) {
            if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
              logger.info({ subId: sub.id, statusCode: pushErr.statusCode }, '[NOTIFIER] Eliminando suscripción web push expirada/inválida.');
              await supabase
                .from('web_push_subscriptions')
                .delete()
                .eq('id', sub.id);
            } else {
              logger.error({ error: pushErr.message || pushErr, subId: sub.id }, '[NOTIFIER] Error al enviar notificación web push individual.');
            }
          }
        }
      }
    } catch (pushGeneralErr: any) {
      logger.error({ error: pushGeneralErr.message || pushGeneralErr, tenantId }, '[NOTIFIER] Error al procesar notificaciones web push.');
    }

    // Actualizar estado de notificación en la base de datos
    const { error: updateErr } = await supabase
      .from('match_queue')
      .update({ is_notified: true })
      .in('id', matchGroup.map(m => m.id));

    if (updateErr) {
      logger.error({ error: updateErr.message, tenantId }, '[NOTIFIER] Error al actualizar estado de notificación en base de datos.');
    }

    return true;
  } catch (sendErr) {
    logger.error({ error: sendErr, tenantId, messageKey }, '[NOTIFIER] Error al despachar mensaje consolidado.');
    return false;
  }
}

/**
 * Ciclo de respaldo: reintenta matches calificados que quedaron sin notificar (por ejemplo, por
 * un fallo transitorio en el envío inmediato o porque la sesión de WhatsApp estaba caída). El
 * envío primario ocurre apenas el coordinador termina de procesar cada mensaje, ver
 * `sendWhatsAppForMatchGroup`.
 */
export async function sendConsolidatedNotifications() {
  logger.info('[NOTIFIER] Ejecutando ciclo de respaldo de notificación...');

  try {
    // 1. Obtener todos los matches calificados pendientes en Supabase
    const { data: pendingMatches, error } = await supabase
      .from('match_queue')
      .select(`
        id,
        tenant_id,
        score,
        whatsapp_group_name,
        whatsapp_sender_name,
        whatsapp_sender_phone,
        raw_message_text,
        property:properties(*)
      `)
      .eq('is_notified', false)
      .eq('is_valid', true)
      .gte('score', 70);

    if (error) throw error;

    if (!pendingMatches || pendingMatches.length === 0) {
      logger.info('[NOTIFIER] No hay matches pendientes de notificación.');
      return;
    }

    logger.info({ pendingCount: pendingMatches.length }, '[NOTIFIER] Procesando matches pendientes...');

    // 2. Agrupar matches por tenant_id
    const matchesByTenant = new Map<string, any[]>();
    pendingMatches.forEach((match: any) => {
      const tenantId = match.tenant_id;
      if (!matchesByTenant.has(tenantId)) {
        matchesByTenant.set(tenantId, []);
      }
      matchesByTenant.get(tenantId)!.push(match);
    });

    // 3. Agrupar por mensaje de origen (mismo remitente + mismo texto) y enviar consolidado
    for (const [tenantId, matches] of matchesByTenant.entries()) {
      const matchesByMessage = new Map<string, any[]>();
      matches.forEach(m => {
        const messageKey = `${m.whatsapp_sender_phone}|${m.raw_message_text}`;
        if (!matchesByMessage.has(messageKey)) {
          matchesByMessage.set(messageKey, []);
        }
        matchesByMessage.get(messageKey)!.push(m);
      });

      for (const matchGroup of matchesByMessage.values()) {
        await sendWhatsAppForMatchGroup(tenantId, matchGroup);
      }
    }
  } catch (error: any) {
    logger.error({ error: error.message || error }, '[NOTIFIER] Error general en el servicio notificador.');
  }
}

/**
 * Inicia el loop en segundo plano del Notificador Consolidado
 */
export function startNotificationService() {
  const intervalMinutes = parseInt(process.env.NOTIFICATION_INTERVAL_MINUTES || '10', 10);
  const intervalMs = intervalMinutes * 60 * 1000;
  
  logger.info({ intervalMinutes }, '[NOTIFIER] Iniciando servicio de notificaciones consolidadas.');
  
  // Ejecutar por primera vez en 10 segundos
  setTimeout(() => {
    sendConsolidatedNotifications();
  }, 10000);

  // Programar loop
  setInterval(() => {
    sendConsolidatedNotifications();
  }, intervalMs);
}
