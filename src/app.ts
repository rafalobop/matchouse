import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import * as path from 'path';
import * as fs from 'fs';
import { config } from './config/env';
import { routes } from './routes';

export function createApp(): express.Application {
  const app = express();

  // KAN-69: nonce por request, consumido tanto por la CSP de Helmet como por el
  // script inyectado en el <head> del dashboard (ver ruta '/' más abajo).
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': ["'self'", (_req, res) => `'nonce-${(res as express.Response).locals.cspNonce}'`]
        }
      }
    })
  );
  app.use(express.json());
  app.use(cookieParser());

  // Servir archivos estáticos del dashboard (soportando dev y prod)
  const dashboardPath = fs.existsSync(path.join(__dirname, 'dashboard'))
    ? path.join(__dirname, 'dashboard')
    : path.join(process.cwd(), 'src', 'dashboard');
  const dashboardIndexHtml = fs.readFileSync(path.join(dashboardPath, 'index.html'), 'utf-8');

  // Gate temporal de acceso privado (pre-lanzamiento): mientras ACCESS_GATE_CODE esté seteada,
  // nadie sin la cookie de acceso puede ver el dashboard ni pegarle a la API. El valor de la
  // cookie es un HMAC del código (no el código en texto plano) firmado con internalWebhookSecret,
  // así que no se puede forjar sin conocer el código. /internal/* queda afuera porque lo llama el
  // trigger de Postgres (pg_net), no un navegador, y ya tiene su propio secreto compartido.
  if (config.accessGateCode) {
    const gateCookieName = 'brokaza_access';
    const gateToken = crypto.createHmac('sha256', config.internalWebhookSecret).update(config.accessGateCode).digest('hex');
    const gatePageHtml = fs.readFileSync(path.join(dashboardPath, 'access-gate.html'), 'utf-8');

    app.use((req, res, next) => {
      if (req.path.startsWith('/internal/')) return next();
      if (req.path === '/health') return next();

      const queryCode = typeof req.query.access === 'string' ? req.query.access : undefined;
      if (queryCode === config.accessGateCode) {
        res.cookie(gateCookieName, gateToken, {
          httpOnly: true,
          sameSite: 'lax',
          secure: config.appUrl.startsWith('https'),
          maxAge: 30 * 24 * 60 * 60 * 1000
        });
        return res.redirect(req.path);
      }

      if (req.cookies?.[gateCookieName] === gateToken) return next();

      if (req.path.startsWith('/api/')) {
        return res.status(503).json({ error: 'Aplicación en acceso privado.' });
      }
      return res.status(503).type('html').send(gatePageHtml);
    });
  }

  // Healthcheck de Railway: sin auth, sin dependencias externas (no toca Supabase) para que el
  // resultado refleje solo si el proceso Node está arriba y respondiendo, no la salud de servicios
  // downstream. Excluido tanto del gate de acceso (arriba) como de la CSP/nonce del dashboard.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // KAN-69: el script que fija el tema (public/scripts/themeSetter.js) necesita el
  // nonce de la request para pasar la CSP — express.static no puede inyectarlo,
  // así que el index.html se sirve con esta ruta dedicada, antes del static del dashboard.
  app.get(['/', '/index.html'], (req, res) => {
    const html = dashboardIndexHtml.replace(
      '<script src="/scripts/themeSetter.js"></script>',
      `<script src="/scripts/themeSetter.js" nonce="${res.locals.cspNonce}"></script>`
    );
    res.type('html').send(html);
  });

  app.use(express.static(path.join(process.cwd(), 'public')));
  app.use(express.static(dashboardPath));

  app.use(routes);

  return app;
}
