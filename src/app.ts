import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import * as path from 'path';
import { routes } from './routes';
import { mountAdminRouter } from './adminRoutes';
import { globalErrorHandler } from './utils/errorHandler';

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
          'script-src': ["'self'", (_req, res) => `'nonce-${(res as express.Response).locals.cspNonce}'`],
          // Tiles de OpenStreetMap para el mapa interactivo del panel admin (corrección de
          // coordenadas de propiedades) — Leaflet en sí está vendorizado en src/admin-dashboard/vendor
          // (sirve como 'self'), solo las imágenes de los tiles vienen de un host externo.
          'img-src': ["'self'", 'data:', 'https://*.tile.openstreetmap.org']
        }
      }
    })
  );
  app.use(express.json());
  app.use(cookieParser());

  // Panel admin (app.admin.brokaza.com): se monta ANTES que el resto del pipeline de tenants
  // (dashboard estático, /api/*) para que, cuando el Host coincide, la request quede completamente
  // aislada en su propio router y nunca llegue a la lógica de tenants — y viceversa, /admin nunca
  // existe si se le pega desde el dominio normal. Quedó sin montar tras el split de src/index.ts en
  // routes/*Routes.ts + controllers/* (commit "add: new routes structure", 2026-08-24) — el router
  // ya existía (src/adminRoutes.ts), solo faltaba este `mountAdminRouter(app)`. Sin ADMIN_HOST
  // seteada no registra nada (panel deshabilitado por completo, ver mountAdminRouter).
  mountAdminRouter(app);

  // Healthcheck de Railway: sin auth, sin dependencias externas (no toca Supabase) para que el
  // resultado refleje solo si el proceso Node está arriba y respondiendo, no la salud de servicios
  // downstream.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(express.static(path.join(process.cwd(), 'public')));

  app.use(routes);

  // KAN-124: manejador de errores global — SIEMPRE al final, después de mountAdminRouter y de
  // todas las rutas de tenant/API, para atrapar tanto errores que suben desde adminRouter (no
  // define su propio error handler, solo un catch-all 404) como de las rutas de tenant. Sin esto,
  // cualquier excepción no capturada (o promesa rechazada dentro de un handler async) cae en el
  // manejador de errores por defecto de Express, que puede incluir el stack trace en la respuesta
  // HTTP. También quedó sin montar en el mismo split de src/index.ts que dejó afuera el panel admin.
  app.use(globalErrorHandler);

  return app;
}
