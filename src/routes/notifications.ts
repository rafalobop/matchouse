import express from 'express';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { validateBodyWhitelist } from '../utils/bodyWhitelist';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';

// KAN-142: suscripción Web Push del tenant, extraído de src/index.ts. El envío efectivo de
// notificaciones vive en services/webPush.ts y se dispara desde routes/search.ts — este módulo
// solo gestiona el ciclo de vida de la suscripción del navegador.

const router = express.Router();

router.get('/api/notifications/vapid-public-key', tenantAuthMiddleware, (req, res) => {
  res.json({ publicKey: config.vapidPublicKey });
});

router.post('/api/notifications/subscribe', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const { subscription } = req.body;
  const supabase = (req as any).supabaseClient;

  // KAN-134: whitelist de campos del body.
  const bodyWhitelistError = validateBodyWhitelist(req.body, ['subscription']);
  if (bodyWhitelistError) {
    return res.status(400).json({ error: bodyWhitelistError });
  }

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }

  try {
    // Buscar si ya existe la suscripción para este tenant
    const { data: existing, error: selectError } = await supabase
      .from('web_push_subscriptions')
      .select('id')
      .eq('tenant_id', tenantId)
      .filter('subscription->>endpoint', 'eq', subscription.endpoint)
      .maybeSingle();

    if (selectError) throw selectError;

    if (!existing) {
      const { error: insertError } = await supabase
        .from('web_push_subscriptions')
        .insert({
          tenant_id: tenantId,
          subscription
        });
      if (insertError) throw insertError;
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ error }, 'Error al registrar suscripción web push');
    res.status(500).json({ error: 'Error interno al suscribir.' });
  }
});

export default router;
