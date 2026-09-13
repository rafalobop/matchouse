import * as express from 'express';
import { supabase } from '../services/supabase';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { withTimeout } from '../utils/withTimeout';
import { getClientIp } from '../utils/clientIp';
import { clearCachedSession } from '../middleware/tenantAuth';
import { sendMagicLinkEmail } from '../services/notifier-email';

export async function getSession(req: express.Request, res: express.Response) {
  const token = req.cookies?.brokaza_session;
  if (!token) return res.json({ authenticated: false });
  try {
    const { data: { user }, error }: any = await withTimeout(
      supabase.auth.getUser(token), 10_000, 'Supabase getUser (session)'
    );
    if (error?.name === 'AuthRetryableFetchError') {
      // No desloguear al usuario por un fallo transitorio de red/TLS hacia Supabase.
      logger.error({ supabaseError: error.message, cause: error.cause }, '[AUTH] No se pudo conectar con Supabase al chequear /session');
      return res.status(503).json({ authenticated: false, error: 'No pudimos conectar con el servidor de autenticación.' });
    }
    if (error || !user) {
      logger.warn({ supabaseError: error?.message }, '[AUTH] Sesión inválida o expirada al chequear /session');
      res.clearCookie('brokaza_session');
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, tenant: { id: user.id, email: user.email } });
  } catch (err: any) {
    logger.error({ err: err.message }, '[AUTH] Error inesperado al verificar sesión');
    res.status(500).json({ authenticated: false, error: 'Error interno al verificar la sesión.' });
  }
}

export async function requestMagicLink(req: express.Request, res: express.Response) {
  const ip = getClientIp(req);
  const { email } = req.body;
  logger.info({ ip, email }, '[AUTH] Solicitud de magic link recibida');

  if (!email || !String(email).includes('@')) {
    logger.warn({ ip, email }, '[AUTH] Email inválido en solicitud de magic link');
    return res.status(400).json({ error: 'Email inválido.' });
  }

  try {
    // 2026-08-27: antes usaba `supabase.auth.signInWithOtp(...)`, que hace mandar el magic link
    // directo por Supabase (su template único, sin logo ni copy de marca — el mail que seguía
    // llegando aunque `notifier-email.ts` ya tuviera el template propio armado, porque nada lo
    // llamaba desde acá). Mismo cambio que ya tenía `adminRoutes.ts`: generamos el link con
    // `generateLink` (no manda ningún email por sí solo) y lo mandamos nosotros por Resend.
    const { data: existingProfile } = await supabase.from('profiles').select('id').eq('email', email).maybeSingle();
    const isFirstTime = !existingProfile;

    const { data, error }: any = await withTimeout(
      supabase.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: config.appUrl } }),
      10_000,
      'Supabase generateLink (tenant)'
    );
    if (error) {
      // AuthRetryableFetchError = Supabase no fue alcanzable (red/TLS/DNS), no un rechazo real del
      // pedido; en ese caso el mensaje del SDK ("fetch failed") no es apto para mostrar al usuario.
      if (error.name === 'AuthRetryableFetchError') {
        logger.error({ ip, email, supabaseError: error.message, cause: error.cause }, '[AUTH] No se pudo conectar con Supabase para enviar el magic link');
        return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
      }
      logger.warn({ ip, email, supabaseError: error.message }, '[AUTH] Supabase rechazó la solicitud de magic link');
      return res.status(400).json({ error: 'No pudimos procesar la solicitud. Verificá el email e intentá de nuevo.' });
    }

    const actionLink = data?.properties?.action_link;
    if (!actionLink) {
      logger.error({ ip, email }, '[AUTH] Supabase generateLink no devolvió action_link');
      return res.status(502).json({ error: 'No pudimos generar el link de acceso. Intentá de nuevo.' });
    }

    const sent = await sendMagicLinkEmail(email, actionLink, isFirstTime);
    if (!sent) {
      logger.error({ ip, email }, '[AUTH] No se pudo enviar el email de magic link');
      return res.status(502).json({ error: 'No pudimos enviar el email de acceso. Intentá de nuevo.' });
    }

    logger.info({ ip, email, isFirstTime }, '[AUTH] Magic link enviado exitosamente');
    res.json({ success: true, message: 'Revisá tu email. Te enviamos un link de acceso.' });
  } catch (err: any) {
    logger.error({ ip, email, err: err.message, stack: err.stack }, '[AUTH] Error inesperado al solicitar magic link (posible timeout o fallo de red hacia Supabase)');
    res.status(500).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
  }
}

export async function exchangeToken(req: express.Request, res: express.Response) {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Token requerido.' });
  try {
    const { data: { user }, error }: any = await withTimeout(
      supabase.auth.getUser(access_token), 10_000, 'Supabase getUser (exchange-token)'
    );
    if (error?.name === 'AuthRetryableFetchError') {
      logger.error({ supabaseError: error.message, cause: error.cause }, '[AUTH] No se pudo conectar con Supabase al intercambiar el token');
      return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
    }
    if (error || !user) {
      logger.warn({ supabaseError: error?.message }, '[AUTH] Token inválido o expirado en exchange-token');
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }
    // Crear perfil en primera sesión si no existe (full_name/email son NOT NULL en la tabla).
    // KAN-90: full_name arranca vacío a propósito — antes se autocompletaba con el local-part
    // del email (`user.email.split('@')[0]`), lo que dejaba nombres reales truncados/falsos
    // ("juan.perez" en vez de "Juan Pérez") sin que el usuario lo notara. Ahora se le pide
    // explícitamente en el formulario de completar perfil (POST /api/profile más abajo), igual
    // que ya pasa con telefono/inmobiliaria/ciudad/pais.
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: user.id,
      email: user.email,
      full_name: ''
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (profileError) {
      logger.error({ tenantId: user.id, err: profileError.message }, '[AUTH] Error al crear/actualizar perfil');
    }
    res.cookie('brokaza_session', access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    logger.info({ tenantId: user.id, email: user.email }, '[AUTH] Sesión establecida vía magic link');
    res.json({ authenticated: true, tenant: { id: user.id, email: user.email } });
  } catch (err: any) {
    logger.error({ err: err.message, stack: err.stack }, '[AUTH] Error inesperado al intercambiar token (posible timeout o fallo de red hacia Supabase)');
    res.status(500).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
  }
}

export function logout(req: express.Request, res: express.Response) {
  const token = req.cookies?.brokaza_session;
  if (token) clearCachedSession(token);
  res.clearCookie('brokaza_session');
  res.json({ success: true });
}
