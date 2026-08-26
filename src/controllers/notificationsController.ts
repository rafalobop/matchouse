import * as express from 'express';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { validateBodyWhitelist } from '../utils/bodyWhitelist';

export function getVapidPublicKey(req: express.Request, res: express.Response) {
  res.json({ publicKey: config.vapidPublicKey });
}

export async function subscribe(req: express.Request, res: express.Response) {
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
    logger.error({ tenantId, err: error.message || error }, '[NOTIFICATIONS] Error al registrar suscripción web push');
    res.status(500).json({ error: 'Error interno al suscribir.' });
  }
}
