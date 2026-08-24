import express from 'express';

/**
 * Extrae de forma robusta la IP del cliente (considerando proxies como Railway). Compartido
 * entre el rate limiter de auth de tenants (src/index.ts) y el del panel admin (src/adminRoutes.ts).
 */
export function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  let ip = 'unknown';
  if (forwarded) {
    const list = typeof forwarded === 'string' ? forwarded.split(',') : forwarded;
    ip = list[0].trim();
  } else {
    ip = req.socket.remoteAddress || 'unknown';
  }

  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    return '127.0.0.1';
  }
  return ip;
}
