import { Resend } from 'resend';
import { supabase } from './supabase';
import { logger } from './logger';
import { config } from '../config/env';

const FROM_ADDRESS = 'Brokaza <hola@brokaza.com>';

// Brokaza Visual Brain v1.0 — mismos tokens que `brokaza-frontend/src/app/globals.css` (paleta
// forest/olive/slate/sage/paper). Los emails no pueden usar CSS variables ni el tema oscuro (cada
// cliente de correo lo renderiza distinto y muchos ignoran `prefers-color-scheme`), así que se
// hardcodean los valores del tema claro directo en los estilos inline de cada template.
const BRAND = {
  forest: '#36461E',
  olive: '#6C863A',
  oliveHover: '#56702E',
  slate: '#617990',
  sage: '#DEE2DC',
  paper: '#F7F8F4',
  white: '#FFFFFF'
};

// El logo vive en `brokaza-frontend/public/logo_brokaza.png` — `config.appUrl` apunta al frontend
// desplegado (Site URL de Supabase, ver SPEC-0013), así que esta URL resuelve al mismo asset que
// ya usan el sidebar/login/loader/404 del dashboard. En local (`APP_URL` sin setear, default
// `http://localhost:3000`) el logo no va a cargar en la preview del email — es esperable, no un
// bug: ningún cliente de correo real puede alcanzar `localhost`.
function brandLogoUrl(): string {
  return `${config.appUrl}/logo_brokaza.png`;
}

/**
 * Shell compartido por los emails "de marca" (magic link ×3, aviso de interesado) — header con
 * logo + título, card clara sobre fondo sage, footer chico. Separado de
 * `buildEmailHtml`/`buildBlindMatchPropertyRowHtml` de más abajo (tema oscuro, sin logo) porque
 * esos son el canal legacy de WhatsApp, dormido (SPEC-0014) y fuera de este rediseño.
 *
 * Layout a base de `<table>` (no `<div>` + `max-width`) — patrón "bulletproof email HTML":
 * Gmail Android, Outlook y varios clientes mobile ignoran `max-width` en `<div>`, así que sin
 * esto la card no se achicaba al ancho del teléfono (quedaba un contenedor ancho, con scroll
 * horizontal, y el CTA de `buildEmailCtaButton` se veía roto/gigante dentro de eso). Las tablas
 * con `width` explícito (no solo `style`) sí las respetan todos los clientes.
 */
function buildBrandedEmailShell(title: string, bodyHtml: string, footerNote?: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.sage};font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.sage};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:460px;width:100%;background:${BRAND.paper};border-radius:16px;box-shadow:0 8px 24px rgba(42,54,56,0.12);">
          <tr>
            <td style="padding:36px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom:20px;">
                    <img src="${brandLogoUrl()}" width="64" height="64" alt="Brokaza" style="display:block;border-radius:16px;" />
                  </td>
                </tr>
              </table>
              <h1 style="text-align:center;color:${BRAND.forest};font-size:20px;margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;">${title}</h1>
              ${bodyHtml}
              <p style="text-align:center;color:${BRAND.slate};font-size:12px;margin-top:28px;font-family:Arial,Helvetica,sans-serif;">${footerNote ?? 'Brokaza — matching inmobiliario para agentes en Tucumán.'}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Botón "bulletproof" — `<a>` como `display:block` adentro de una celda de tabla con ancho
 * acotado (`max-width:280px`, centrada con `align="center"` en la tabla exterior), en vez del
 * `<div>` + `<a display:inline-block>` anterior. Esa versión no tenía ningún tope de ancho propio:
 * en clientes que no recortan el `<div>` padre al ancho de pantalla (ver comentario de
 * `buildBrandedEmailShell`), el botón se estiraba con el resto del contenedor roto.
 */
function buildEmailCtaButton(link: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto;width:100%;max-width:280px;">
    <tr>
      <td align="center" bgcolor="${BRAND.olive}" style="border-radius:8px;">
        <a href="${link}" target="_blank" style="display:block;padding:14px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:${BRAND.white};text-decoration:none;border-radius:8px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

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
    <h2 style="color:#ffffff;">🏠 Brokaza — Nuevos matches detectados</h2>
    <p>Grupo: <strong>${groupName}</strong></p>
    <p style="color:#94a3b8;">Pedido: "${truncatedText}" — Cliente: ${sender}</p>
    <table style="width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;">
      ${rows}
    </table>
    <p style="color:#64748b;font-size:12px;margin-top:16px;">Gestioná y revisá el feedback de estos matches desde tu Dashboard de Brokaza.</p>
  </div>
  <img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;" />
</body>
</html>`;
}

// KAN-48: fila de propiedad para los emails del matching ciego (`domicilio`/`precio`/`moneda`/
// etc., ver mapeo en src/index.ts — otra forma que el `match_queue` legacy de WhatsApp que usa
// buildEmailHtml/buildPropertyRowHtml de más arriba). Compartida entre los dos emails de este
// dominio — hoy solo la usa `buildIncomingMatchEmailHtml` (aviso al dueño de la propiedad
// matcheada); el email equivalente al buscador (`buildBlindMatchEmailHtml`/
// `sendBlindMatchEmailFallback`) se retiró por decisión de producto (2026-08-21) — el buscador ya
// no se notifica de los matches de su propia búsqueda, ver `src/routes/search.ts`.
export function buildBlindMatchPropertyRowHtml(match: any): string {
  const prop = match.property;
  const direccion = prop.pisoLote ? `${prop.domicilio} (${prop.pisoLote})` : prop.domicilio;

  return `
    <tr>
      <td style="padding:16px;border-bottom:1px solid rgba(42,54,56,0.1);">
        <strong style="color:${BRAND.forest};">${direccion}</strong><br/>
        <span style="color:${BRAND.slate};font-size:13px;">${prop.tipo_propiedad} · ${prop.operacion} · ${prop.dormitorios} dorm.</span><br/>
        <span style="color:${BRAND.olive};font-weight:700;">${prop.moneda} ${prop.precio}</span>
      </td>
    </tr>`;
}

// KAN-78: aviso al dueño de la propiedad matcheada de que un agente la buscó — único lado que se
// notifica (ver comentario de `buildBlindMatchPropertyRowHtml` de más arriba). A diferencia del
// push (genérico por privacidad, ver buildIncomingMatchPushPayload en webPush.ts), el email SÍ incluye
// el contacto completo del buscador (nombre/teléfono/inmobiliaria) porque es un canal privado 1:1
// con el dueño de la propiedad — sin este dato, el dueño no tiene forma de contactar al
// interesado si no revisa el dashboard a tiempo (gap identificado en KAN-78).
export function buildIncomingMatchEmailHtml(searcherSnapshot: { full_name: string | null; phone_number: string | null; agency_name: string | null }, searchText: string, matches: any[]): string {
  const truncatedText = searchText.length > 150 ? `${searchText.substring(0, 150)}...` : searchText;
  const rows = matches.map(buildBlindMatchPropertyRowHtml).join('\n');
  const contactoLinea = [searcherSnapshot.full_name, searcherSnapshot.agency_name, searcherSnapshot.phone_number]
    .filter(Boolean)
    .join(' · ');

  const body = `
    <p style="text-align:center;color:${BRAND.slate};font-size:14px;margin:0 0 4px;">Búsqueda: "${truncatedText}"</p>
    <p style="text-align:center;color:${BRAND.forest};font-weight:700;font-size:15px;margin:0 0 24px;">Contacto: ${contactoLinea || 'Sin datos de contacto disponibles'}</p>
    <table style="width:100%;border-collapse:collapse;background:${BRAND.white};border-radius:12px;overflow:hidden;border:1px solid rgba(42,54,56,0.12);">
      ${rows}
    </table>`;

  return buildBrandedEmailShell(
    'Un agente busca una propiedad como una de las tuyas',
    body,
    'Entrá a tu Dashboard de Brokaza para ver el detalle completo.'
  );
}

export async function sendIncomingMatchEmailFallback(matchedTenantId: string, searcherSnapshot: { full_name: string | null; phone_number: string | null; agency_name: string | null }, searchText: string, matches: any[], client = supabase): Promise<boolean> {
  if (!matches || matches.length === 0) return false;

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('email')
    .eq('id', matchedTenantId)
    .single();

  if (profileError || !profile?.email) {
    logger.warn({ matchedTenantId }, '[NOTIFIER-EMAIL] Dueño de propiedad matcheada sin email registrado en profiles. Omitiendo aviso entrante.');
    return false;
  }

  const html = buildIncomingMatchEmailHtml(searcherSnapshot, searchText, matches);

  try {
    const resend = getResendClient();
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: profile.email,
      subject: `🏠 Brokaza: un agente busca ${matches.length} de tus propiedades`,
      html
    });

    if (result.error) {
      logger.error({ error: result.error, matchedTenantId }, '[NOTIFIER-EMAIL] Resend devolvió un error al enviar el aviso entrante.');
      return false;
    }

    logger.info({ matchedTenantId, matchCount: matches.length, emailId: result.data?.id }, '[NOTIFIER-EMAIL] Email de aviso entrante (dueño de propiedad) enviado con éxito.');
    return true;
  } catch (sendErr: any) {
    logger.error({ error: sendErr.message || sendErr, matchedTenantId }, '[NOTIFIER-EMAIL] Error al despachar el email de aviso entrante.');
    return false;
  }
}

// KAN-58: aviso de reenganche ("¿la renovás?") — canal de respaldo del push
// (buildReengagementPushPayload en webPush.ts) para el mismo evento: la búsqueda del tenant venció
// (7 días, KAN-41) sin haber recibido ningún match (`blind_matches.search_id`, ver
// `src/services/reengagement.ts`). Mismo shell de marca que el resto de los emails "de marca"
// (magic link, aviso de interesado) — a diferencia de los emails legacy de match_queue, este
// dominio nunca usó el tema oscuro sin marca.
export function buildReengagementEmailHtml(rawText: string): string {
  const truncatedText = rawText.length > 150 ? `${rawText.substring(0, 150)}...` : rawText;
  const body = `
    <p style="text-align:center;color:${BRAND.slate};font-size:14px;line-height:1.5;">
      Tu búsqueda "${truncatedText}" venció hace 7 días sin ningún match. ¿La renovás para seguir recibiendo propiedades que puedan interesarte?
    </p>
    ${buildEmailCtaButton(config.appUrl, 'Renovar búsqueda')}`;

  return buildBrandedEmailShell('¿La renovás?', body);
}

export async function sendReengagementEmail(tenantId: string, rawText: string, client = supabase): Promise<boolean> {
  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('email')
    .eq('id', tenantId)
    .single();

  if (profileError || !profile?.email) {
    logger.warn({ tenantId }, '[NOTIFIER-EMAIL] Tenant sin email registrado en profiles. Omitiendo aviso de reenganche.');
    return false;
  }

  const html = buildReengagementEmailHtml(rawText);

  try {
    const resend = getResendClient();
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: profile.email,
      subject: '¿La renovás? Tu búsqueda en Matchouse venció sin matches',
      html
    });

    if (result.error) {
      logger.error({ error: result.error, tenantId }, '[NOTIFIER-EMAIL] Resend devolvió un error al enviar el aviso de reenganche.');
      return false;
    }

    logger.info({ tenantId, emailId: result.data?.id }, '[NOTIFIER-EMAIL] Email de reenganche enviado con éxito.');
    return true;
  } catch (sendErr: any) {
    logger.error({ error: sendErr.message || sendErr, tenantId }, '[NOTIFIER-EMAIL] Error al despachar el email de reenganche.');
    return false;
  }
}

// Magic link (2026-08-22) — antes lo mandaba Supabase directo (`signInWithOtp`), con un único
// template global (dashboard de Supabase) sin forma de diferenciar tenant/admin ni primera
// vez/ya registrado. Ahora `src/routes/auth.ts`/`src/adminRoutes.ts` generan el link con
// `supabase.auth.admin.generateLink()` (no manda ningún email por sí solo) y lo insertan acá en
// nuestro propio HTML de marca, mandado por Resend — mismo mecanismo que ya usaba
// `sendIncomingMatchEmailFallback`. El `action_link` que devuelve `generateLink()` apunta al
// verify endpoint de Supabase y termina redirigiendo a `APP_URL` con el `#access_token=...` en el
// hash — el frontend (`consumeAuthCallbackHash`) no necesita ningún cambio, es el mismo shape que
// ya procesaba viniendo del email nativo de Supabase.

export function buildMagicLinkFirstTimeEmailHtml(link: string): string {
  const body = `
    <p style="text-align:center;color:${BRAND.slate};font-size:14px;line-height:1.5;">
      Activá tu cuenta para empezar a cargar tu cartera y cruzarla automáticamente con pedidos de otros agentes.
    </p>
    ${buildEmailCtaButton(link, 'Activar mi cuenta')}
    <p style="text-align:center;color:${BRAND.slate};font-size:12px;">
      Si vos no pediste este acceso, podés ignorar este email.
    </p>`;

  return buildBrandedEmailShell('¡Bienvenido a Brokaza!', body);
}

export function buildMagicLinkReturningEmailHtml(link: string): string {
  const body = `
    <p style="text-align:center;color:${BRAND.slate};font-size:14px;line-height:1.5;">
      Tocá el botón para entrar a tu dashboard — vas a ver tus búsquedas activas, matches e interesados en tu cartera.
    </p>
    ${buildEmailCtaButton(link, 'Ingresar a Brokaza')}
    <p style="text-align:center;color:${BRAND.slate};font-size:12px;">
      Si vos no pediste este acceso, podés ignorar este email.
    </p>`;

  return buildBrandedEmailShell('¡Hola de nuevo!', body);
}

export function buildAdminMagicLinkEmailHtml(link: string): string {
  const body = `
    <p style="text-align:center;color:${BRAND.slate};font-size:14px;line-height:1.5;">
      Ingresá para ver cómo viene el uso de Brokaza — propiedades cargadas, usuarios registrados y activos, y matches totales de la plataforma.
    </p>
    ${buildEmailCtaButton(link, 'Ir al panel admin')}
    <p style="text-align:center;color:${BRAND.slate};font-size:12px;">
      Si vos no pediste este acceso, podés ignorar este email.
    </p>`;

  return buildBrandedEmailShell('Hola, administrador', body);
}

export async function sendMagicLinkEmail(email: string, link: string, isFirstTime: boolean): Promise<boolean> {
  const html = isFirstTime ? buildMagicLinkFirstTimeEmailHtml(link) : buildMagicLinkReturningEmailHtml(link);
  const subject = isFirstTime ? 'Bienvenido a Brokaza — activá tu cuenta' : 'Tu acceso a Brokaza';

  try {
    const resend = getResendClient();
    const result = await resend.emails.send({ from: FROM_ADDRESS, to: email, subject, html });

    if (result.error) {
      logger.error({ error: result.error, isFirstTime }, '[NOTIFIER-EMAIL] Resend devolvió un error al enviar el magic link.');
      return false;
    }

    logger.info({ isFirstTime, emailId: result.data?.id }, '[NOTIFIER-EMAIL] Magic link enviado con éxito.');
    return true;
  } catch (sendErr: any) {
    logger.error({ error: sendErr.message || sendErr, isFirstTime }, '[NOTIFIER-EMAIL] Error al despachar el email de magic link.');
    return false;
  }
}

export async function sendAdminMagicLinkEmail(email: string, link: string): Promise<boolean> {
  const html = buildAdminMagicLinkEmailHtml(link);

  try {
    const resend = getResendClient();
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: email,
      subject: 'Acceso al panel admin de Brokaza',
      html
    });

    if (result.error) {
      logger.error({ error: result.error }, '[NOTIFIER-EMAIL] Resend devolvió un error al enviar el magic link de admin.');
      return false;
    }

    logger.info({ emailId: result.data?.id }, '[NOTIFIER-EMAIL] Magic link de admin enviado con éxito.');
    return true;
  } catch (sendErr: any) {
    logger.error({ error: sendErr.message || sendErr }, '[NOTIFIER-EMAIL] Error al despachar el email de magic link de admin.');
    return false;
  }
}

// KAN-306 (cambio de flujo de colaboradores): aviso para el caso "el email invitado ya tenía
// cuenta" — a diferencia de una cuenta nueva (que recibe el magic link de bienvenida vía
// `sendMagicLinkEmail`), acá no hace falta ningún link de acceso, solo notificar que ya puede
// entrar con su login normal.
export function buildCollaboratorAccessGrantedEmailHtml(): string {
  const body = `
    <p style="text-align:center;color:${BRAND.slate};font-size:14px;line-height:1.5;">
      Un dueño de agencia te dio acceso como colaborador en Brokaza. Ya podés entrar con tu cuenta de siempre.
    </p>
    ${buildEmailCtaButton(config.appUrl, 'Ir a Brokaza')}
    <p style="text-align:center;color:${BRAND.slate};font-size:12px;">
      Si no esperabas este acceso, podés ignorar este email.
    </p>`;

  return buildBrandedEmailShell('Te dieron acceso como colaborador', body);
}

export async function sendCollaboratorAccessGrantedEmail(email: string): Promise<boolean> {
  const html = buildCollaboratorAccessGrantedEmailHtml();

  try {
    const resend = getResendClient();
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: email,
      subject: 'Te dieron acceso como colaborador en Brokaza',
      html
    });

    if (result.error) {
      logger.error({ error: result.error }, '[NOTIFIER-EMAIL] Resend devolvió un error al enviar el aviso de acceso de colaborador.');
      return false;
    }

    logger.info({ emailId: result.data?.id }, '[NOTIFIER-EMAIL] Aviso de acceso de colaborador enviado con éxito.');
    return true;
  } catch (sendErr: any) {
    logger.error({ error: sendErr.message || sendErr }, '[NOTIFIER-EMAIL] Error al despachar el aviso de acceso de colaborador.');
    return false;
  }
}
