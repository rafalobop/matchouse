import express from 'express';
import { supabase } from '../services/supabase';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { withTimeout } from '../utils/withTimeout';
import { createDistributedRateLimiter } from '../utils/rateLimit';
import { getClientIp } from '../utils/clientIp';
import { clearCachedSession } from '../middleware/tenantAuth';
import { sendMagicLinkEmail } from '../services/notifier-email';

// KAN-142: rutas públicas de autenticación (magic link de Supabase, SPEC-0013), extraídas de
// src/index.ts. Dependen únicamente de services/supabase (cliente service-role) y no de
// middleware/tenantAuth más allá de limpiar la cache de sesión en logout.

// KAN-127: rate limiter distribuido (backend Postgres, ver src/utils/rateLimit.ts) para el
// endpoint de auth (max 5 req/min por IP) — antes vivía en memoria del proceso acá mismo, lo que
// multiplicaba el límite efectivo por instancia detrás de un balanceador de carga.
const authRateLimiter = createDistributedRateLimiter('auth', 5, 60_000);

const router = express.Router();

router.get('/api/auth/session', async (req, res) => {
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
});

router.post('/api/auth/request-magic-link', async (req, res) => {
  const ip = getClientIp(req);
  const { email } = req.body;
  logger.info({ ip, email }, '[AUTH] Solicitud de magic link recibida');

  if (!(await authRateLimiter.check(ip))) {
    logger.warn({ ip, email }, '[AUTH] Rate limit excedido en solicitud de magic link');
    return res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto e intentá de nuevo.' });
  }
  if (!email || !String(email).includes('@')) {
    logger.warn({ ip, email }, '[AUTH] Email inválido en solicitud de magic link');
    return res.status(400).json({ error: 'Email inválido.' });
  }

  try {
    // 2026-08-22: `profiles` solo tiene fila una vez que el tenant completó al menos un login
    // exitoso (upsert en POST /api/auth/exchange-token) — su ausencia es la señal de "primera
    // vez" que necesitamos para elegir el template de email correcto, sin depender de
    // `auth.users` (fuera del schema público).
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    const isFirstTime = !existingProfile;

    const { data, error }: any = await withTimeout(
      supabase.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: config.appUrl } }),
      10_000,
      'Supabase generateLink (magic link)'
    );
    if (error) {
      // AuthRetryableFetchError = Supabase no fue alcanzable (red/TLS/DNS), no un rechazo real del
      // pedido; en ese caso el mensaje del SDK ("fetch failed") no es apto para mostrar al usuario.
      if (error.name === 'AuthRetryableFetchError') {
        logger.error({ ip, email, supabaseError: error.message, cause: error.cause }, '[AUTH] No se pudo conectar con Supabase para generar el magic link');
        return res.status(503).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
      }
      logger.warn({ ip, email, supabaseError: error.message }, '[AUTH] Supabase rechazó la generación del magic link');
      return res.status(400).json({ error: error.message });
    }

    const actionLink = data?.properties?.action_link;
    if (!actionLink) {
      logger.error({ ip, email }, '[AUTH] Supabase generateLink no devolvió action_link');
      return res.status(502).json({ error: 'No pudimos generar el link de acceso. Intentá de nuevo en unos segundos.' });
    }

    // 2026-08-22: el email ya no lo manda Supabase (KAN-269 — su template único no puede
    // diferenciar primera vez/ya registrado) — lo mandamos nosotros por Resend con
    // `sendMagicLinkEmail` (src/services/notifier-email.ts), mismo mecanismo que el aviso de
    // interesados.
    const sent = await sendMagicLinkEmail(email, actionLink, isFirstTime);
    if (!sent) {
      return res.status(502).json({ error: 'No pudimos enviar el email de acceso. Intentá de nuevo en unos segundos.' });
    }

    logger.info({ ip, email, isFirstTime }, '[AUTH] Magic link enviado exitosamente');
    res.json({ success: true, message: 'Revisá tu email. Te enviamos un link de acceso.' });
  } catch (err: any) {
    logger.error({ ip, email, err: err.message, stack: err.stack }, '[AUTH] Error inesperado al solicitar magic link (posible timeout o fallo de red hacia Supabase)');
    res.status(500).json({ error: 'No pudimos conectar con el servidor de autenticación. Intentá de nuevo en unos segundos.' });
  }
});

router.post('/api/auth/exchange-token', async (req, res) => {
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
    // explícitamente en el formulario de completar perfil (POST /api/profile, ver routes/profile.ts),
    // igual que ya pasa con telefono/inmobiliaria/ciudad/pais.
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
});

router.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.brokaza_session;
  if (token) clearCachedSession(token);
  res.clearCookie('brokaza_session');
  res.json({ success: true });
});

export default router;
