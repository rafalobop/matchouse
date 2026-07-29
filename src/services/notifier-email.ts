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

/**
 * Agrupa matches por mensaje de origen (mismo remitente + mismo texto), que es la unidad
 * que se consolida en un único email.
 */
export function groupMatchesByMessage(matches: any[]): Map<string, any[]> {
  const byMessage = new Map<string, any[]>();
  matches.forEach((match) => {
    const messageKey = `${match.whatsapp_sender_phone}|${match.raw_message_text}`;
    if (!byMessage.has(messageKey)) byMessage.set(messageKey, []);
    byMessage.get(messageKey)!.push(match);
  });
  return byMessage;
}

export function buildWhatsAppMessage(groupName: string, property: any, senderName?: string, requestText?: string): string {
  const greeting = senderName ? `Hola ${senderName}` : 'Hola';

  const pisoLote = [property.floor, property.unit, property.block, property.lot].filter(Boolean).join(' ');
  const direccion = pisoLote ? `${property.address} (${pisoLote})` : property.address;
  const detalle = [property.property_type, property.operation].filter(Boolean).join(' en ');

  const truncatedRequest = requestText && requestText.length > 120 ? `${requestText.slice(0, 120)}...` : requestText;
  const contexto = truncatedRequest
    ? ` Vi tu mensaje en el grupo "${groupName}" ("${truncatedRequest}")`
    : ` Vi tu pedido en el grupo "${groupName}"`;

  return `${greeting}!${contexto} y justo tenemos en cartera ${direccion}${detalle ? `, ${detalle}` : ''} a ${property.currency} ${property.price}. ¿Te gustaría que te pase la ficha técnica?`;
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
 * Envía un único email consolidado con todos los matches de un mismo mensaje (mismo remitente +
 * mismo texto) y marca esos matches como notificados. Se usa tanto para el envío inmediato
 * (disparado apenas el coordinador termina de procesar un mensaje) como para el ciclo de
 * respaldo que reintenta matches que quedaron pendientes por algún error transitorio.
 */
export async function sendEmailForMatchGroup(tenantId: string, matchGroup: any[]): Promise<boolean> {
  if (!matchGroup || matchGroup.length === 0) return false;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', tenantId)
    .single();

  if (profileError || !profile?.email) {
    logger.warn({ tenantId }, '[NOTIFIER-EMAIL] Tenant sin email registrado en profiles. Omitiendo.');
    return false;
  }

  const first = matchGroup[0];
  const html = buildEmailHtml(first.whatsapp_group_name, first.raw_message_text, first.whatsapp_sender_name, matchGroup);

  try {
    const resend = getResendClient();
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: profile.email,
      subject: `🏠 HouseMatch: ${matchGroup.length} match(es) para ${first.whatsapp_sender_name}`,
      html
    });

    if (result.error) {
      logger.error({ error: result.error, tenantId }, '[NOTIFIER-EMAIL] Resend devolvió un error al enviar.');
      return false;
    }

    logger.info({ tenantId, matchCount: matchGroup.length, emailId: result.data?.id }, '[NOTIFIER-EMAIL] Email consolidado enviado con éxito.');

    const { error: updateErr } = await supabase
      .from('match_queue')
      .update({ is_notified: true })
      .in('id', matchGroup.map(m => m.id));

    if (updateErr) {
      logger.error({ error: updateErr.message, tenantId }, '[NOTIFIER-EMAIL] Error al actualizar estado de notificación en base de datos.');
    }

    return true;
  } catch (sendErr: any) {
    logger.error({ error: sendErr.message || sendErr, tenantId }, '[NOTIFIER-EMAIL] Error al despachar email consolidado.');
    return false;
  }
}

/**
 * Ciclo de respaldo: reintenta matches calificados que quedaron sin notificar (por ejemplo, por
 * un fallo transitorio en el envío inmediato). El envío primario ocurre apenas el coordinador
 * termina de procesar cada mensaje, ver `sendEmailForMatchGroup`.
 */
export async function sendConsolidatedEmailNotifications(): Promise<void> {
  logger.info('[NOTIFIER-EMAIL] Ejecutando ciclo de respaldo de notificación por email...');

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

    for (const [tenantId, matches] of matchesByTenant.entries()) {
      const matchesByMessage = groupMatchesByMessage(matches);
      for (const matchGroup of matchesByMessage.values()) {
        await sendEmailForMatchGroup(tenantId, matchGroup);
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

// KAN-48: email como canal de respaldo permanente para el evento "match encontrado" del matching
// ciego (POST /api/search, KAN-44/45/46) — plantilla nueva porque el match ahí tiene otra forma
// (`domicilio`/`precio`/`moneda`/etc., ver mapeo en src/index.ts) que el `match_queue` legacy de
// WhatsApp que usa buildEmailHtml/buildPropertyRowHtml de más arriba. A diferencia del push (que
// por privacidad viaja genérico, sin datos de la propiedad), acá sí se incluye el detalle completo
// porque el email es un canal privado 1:1 con el tenant dueño de la búsqueda, mismo nivel de
// acceso que ya tenía la respuesta HTTP original de POST /api/search.
export function buildBlindMatchPropertyRowHtml(match: any): string {
  const prop = match.property;
  const direccion = prop.pisoLote ? `${prop.domicilio} (${prop.pisoLote})` : prop.domicilio;

  return `
    <tr>
      <td style="padding:16px;border-bottom:1px solid #2d3b53;">
        <strong style="color:#f1f5f9;">${direccion}</strong><br/>
        <span style="color:#94a3b8;font-size:13px;">${prop.tipo_propiedad} · ${prop.operacion} · ${prop.dormitorios} dorm.</span><br/>
        <span style="color:#f1f5f9;font-weight:600;">${prop.moneda} ${prop.precio}</span>
      </td>
    </tr>`;
}

export function buildBlindMatchEmailHtml(searchText: string, matches: any[]): string {
  const truncatedText = searchText.length > 150 ? `${searchText.substring(0, 150)}...` : searchText;
  const rows = matches.map(buildBlindMatchPropertyRowHtml).join('\n');

  return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,Helvetica,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;margin:0;">
  <div style="max-width:600px;margin:0 auto;">
    <h2 style="color:#ffffff;">🏠 Matchouse — Nuevos matches para tu búsqueda</h2>
    <p style="color:#94a3b8;">Tu búsqueda: "${truncatedText}"</p>
    <table style="width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;">
      ${rows}
    </table>
    <p style="color:#64748b;font-size:12px;margin-top:16px;">Entrá a tu Dashboard de Matchouse para ver el detalle completo y gestionar tus búsquedas.</p>
  </div>
</body>
</html>`;
}

export async function sendBlindMatchEmailFallback(tenantId: string, searchText: string, matches: any[], client = supabase): Promise<boolean> {
  if (!matches || matches.length === 0) return false;

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('email')
    .eq('id', tenantId)
    .single();

  if (profileError || !profile?.email) {
    logger.warn({ tenantId }, '[NOTIFIER-EMAIL] Tenant sin email registrado en profiles. Omitiendo fallback de matching ciego.');
    return false;
  }

  const html = buildBlindMatchEmailHtml(searchText, matches);

  try {
    const resend = getResendClient();
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: profile.email,
      subject: `🏠 Matchouse: ${matches.length} match(es) nuevo(s) para tu búsqueda`,
      html
    });

    if (result.error) {
      logger.error({ error: result.error, tenantId }, '[NOTIFIER-EMAIL] Resend devolvió un error al enviar el fallback de matching ciego.');
      return false;
    }

    logger.info({ tenantId, matchCount: matches.length, emailId: result.data?.id }, '[NOTIFIER-EMAIL] Email de respaldo (matching ciego) enviado con éxito.');
    return true;
  } catch (sendErr: any) {
    logger.error({ error: sendErr.message || sendErr, tenantId }, '[NOTIFIER-EMAIL] Error al despachar el email de respaldo de matching ciego.');
    return false;
  }
}

export function stopEmailNotificationService(): void {
  if (emailInterval) {
    clearInterval(emailInterval);
    emailInterval = null;
  }
}
