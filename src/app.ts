import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import * as path from 'path';
import { routes } from './routes';

export function createApp(): express.Application {
  const app = express();

  // KAN-69: nonce por request, consumido por la CSP de Helmet. También usado por el panel admin
  // (src/adminRoutes.ts) para el script inline de su propio index.html.
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

  // Healthcheck de Railway: sin auth, sin dependencias externas (no toca Supabase) para que el
  // resultado refleje solo si el proceso Node está arriba y respondiendo, no la salud de servicios
  // downstream.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(express.static(path.join(process.cwd(), 'public')));

  app.use(routes);

  return app;
}
