import { Resend } from 'resend';
import { supabase } from './supabase';
import { logger } from './logger';
import { config } from '../config/env';

const FROM_ADDRESS = 'HouseMatch <onboarding@resend.dev>';

let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!resendClient) {
    if (!config.resendApiKey) {
      throw new Error('Falta SENDER_API_KEY (Resend) para notificaciones por email.');
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

export function groupMatchesByTenant(matches: any[]): Map<string, any[]> {
  const byTenant = new Map<string, any[]>();
  matches.forEach((match) => {
    const tenantId = match.tenant_id;
    if (!byTenant.has(tenantId)) byTenant.set(tenantId, []);
    byTenant.get(tenantId)!.push(match);
  });
  return byTenant;
}

export function groupMatchesByWhatsAppGroup(matches: any[]): Map<string, any[]> {
  const byGroup = new Map<string, any[]>();
  matches.forEach((match) => {
    const groupKey = match.whatsapp_group_name || 'default';
    if (!byGroup.has(groupKey)) byGroup.set(groupKey, []);
    byGroup.get(groupKey)!.push(match);
  });
  return byGroup;
}

export function buildWhatsAppMessage(groupName: string, property: any): string {
  return `Hola! Te contacto por tu pedido en el grupo "${groupName}". Tenemos esta opción que podría interesarte: ${property.address} - ${property.currency} ${property.price}. ¿Te gustaría más info?`;
}

export function buildPropertyRowHtml(match: any): string {
  const prop = match.property;
  const pisoLote = [prop.floor, prop.unit, prop.block, prop.lot].filter(Boolean).join(' ');
  const clickUrl = `${config.appUrl}/api/notifications/email/click/${match.id}`;

  return `
    <tr>
      <td style="padding:16px;border-bottom:1px solid #2d3b53;">
        <strong style="color:#f1f5f9;">${prop.address}</strong>${pisoLote ? ` (${pisoLote})` : ''}<br/>
        <span style="color:#94a3b8;font-size:13px;">${prop.property_type} · ${prop.operation} · ${prop.bedrooms} dorm.</span><br/>
        <span style="color:#f1f5f9;font-weight:600;">${prop.currency} ${prop.price}</span><br/>
        <a href="${clickUrl}" style="display:inline-block;margin-top:10px;padding:8px 16px;background:#25D366;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Contactar al cliente por WhatsApp</a>
      </td>
    </tr>`;
}

export function buildEmailHtml(groupName: string, originalText: string, sender: string, matches: any[]): string {
  const pixelUrl = `${config.appUrl}/api/notifications/email/pixel/${matches[0].id}.gif`;
  const truncatedText = originalText.length > 150 ? `${originalText.substring(0, 150)}...` : originalText;
  const rows = matches.map(buildPropertyRowHtml).join('\n');

  return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,Helvetica,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;margin:0;">
  <div style="max-width:600px;margin:0 auto;">
    <h2 style="color:#ffffff;">🏠 HouseMatch — Nuevos matches detectados</h2>
    <p>Grupo: <strong>${groupName}</strong></p>
    <p style="color:#94a3b8;">Pedido: "${truncatedText}" — Cliente: ${sender}</p>
    <table style="width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;">
      ${rows}
    </table>
    <p style="color:#64748b;font-size:12px;margin-top:16px;">Gestioná y revisá el feedback de estos matches desde tu Dashboard de HouseMatch.</p>
  </div>
  <img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;" />
</body>
</html>`;
}

/**
 * Ejecuta el envío consolidado de matches pendientes de notificación por email
 */
export async function sendConsolidatedEmailNotifications(): Promise<void> {
  logger.info('[NOTIFIER-EMAIL] Ejecutando ciclo de notificación consolidada por email...');

  try {
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
      logger.info('[NOTIFIER-EMAIL] No hay matches pendientes de notificación.');
      return;
    }

    const matchesByTenant = groupMatchesByTenant(pendingMatches);

    const resend = getResendClient();

    for (const [tenantId, matches] of matchesByTenant.entries()) {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', tenantId)
        .single();

      if (profileError || !profile?.email) {
        logger.warn({ tenantId }, '[NOTIFIER-EMAIL] Tenant sin email registrado en profiles. Omitiendo.');
        continue;
      }

      const matchesByGroup = groupMatchesByWhatsAppGroup(matches);

      const processedMatchIds: string[] = [];

      for (const [groupKey, matchGroup] of matchesByGroup.entries()) {
        const first = matchGroup[0];
        const html = buildEmailHtml(first.whatsapp_group_name, first.raw_message_text, first.whatsapp_sender_name, matchGroup);

        try {
          const result = await resend.emails.send({
            from: FROM_ADDRESS,
            to: profile.email,
            subject: `🏠 HouseMatch: ${matchGroup.length} match(es) en ${first.whatsapp_group_name}`,
            html
          });

          if (result.error) {
            logger.error({ error: result.error, tenantId, groupKey }, '[NOTIFIER-EMAIL] Resend devolvió un error al enviar.');
            continue;
          }

          logger.info({ tenantId, groupKey, matchCount: matchGroup.length, emailId: result.data?.id }, '[NOTIFIER-EMAIL] Email consolidado enviado con éxito.');
          matchGroup.forEach(m => processedMatchIds.push(m.id));
        } catch (sendErr: any) {
          logger.error({ error: sendErr.message || sendErr, tenantId, groupKey }, '[NOTIFIER-EMAIL] Error al despachar email consolidado.');
        }
      }

      if (processedMatchIds.length > 0) {
        const { error: updateErr } = await supabase
          .from('match_queue')
          .update({ is_notified: true })
          .in('id', processedMatchIds);

        if (updateErr) {
          logger.error({ error: updateErr.message, tenantId }, '[NOTIFIER-EMAIL] Error al actualizar estado de notificación en base de datos.');
        } else {
          logger.info({ tenantId, updatedCount: processedMatchIds.length }, '[NOTIFIER-EMAIL] Estado de matches actualizado a notificado en Supabase.');
        }
      }
    }
  } catch (error: any) {
    logger.error({ error: error.message || error }, '[NOTIFIER-EMAIL] Error general en el servicio notificador por email.');
  }
}

let emailInterval: NodeJS.Timeout | null = null;

/**
 * Inicia el loop en segundo plano del Notificador Consolidado por Email
 */
export function startEmailNotificationService(): void {
  const intervalMs = config.notificationIntervalMinutes * 60 * 1000;

  logger.info({ intervalMinutes: config.notificationIntervalMinutes }, '[NOTIFIER-EMAIL] Iniciando servicio de notificaciones consolidadas por email.');

  setTimeout(() => {
    sendConsolidatedEmailNotifications();
  }, 10000);

  emailInterval = setInterval(() => {
    sendConsolidatedEmailNotifications();
  }, intervalMs);
}

export function stopEmailNotificationService(): void {
  if (emailInterval) {
    clearInterval(emailInterval);
    emailInterval = null;
  }
}
