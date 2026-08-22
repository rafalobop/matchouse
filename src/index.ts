import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import http from 'http';
import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import * as path from 'path';
import * as fs from 'fs';
import { initExcelParsePool } from './services/excelParsePool';
import { initRealtimeHub } from './services/realtimeHub';
import { startDolarService } from './services/dolar';
import { startSearchExpirationService } from './services/searchExpiration';
import { config } from './config/env';
import { logger } from './services/logger';
import { buildHealthPayload } from './utils/health';
import { mountAdminRouter } from './adminRoutes';
import { nodeEnvCheckMiddleware } from './utils/nodeEnvCheck';
import { globalErrorHandler } from './utils/errorHandler';
import { JSON_BODY_SIZE_LIMIT, jsonBodyParseErrorHandler } from './utils/bodyWhitelist';
import authRouter from './routes/auth';
import profileRouter from './routes/profile';
import uploadRouter from './routes/upload';
import searchRouter from './routes/search';
import matchesRouter from './routes/matches';
import notificationsRouter from './routes/notifications';
import systemRouter from './routes/system';
import propertiesRouter from './routes/properties';

// KAN-142: src/index.ts quedó reducido al bootstrap de la app (Express, seguridad HTTP, archivos
// estáticos, gate de acceso privado) y al arranque de los servicios de fondo — toda la lógica de
// negocio de las rutas vive en src/routes/*, organizada por dominio (auth, profile, upload,
// search, matches, notifications, system), montada acá como routers independientes. El mapa de
// dependencias entre estos módulos está documentado en
// docs/evolucion_proyecto/refactor_index_routes.md.

// Express Setup
const app = express();
const PORT = process.env.PORT || 3000;

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, '[PROCESO] Promesa no capturada (Unhandled Rejection)');
});

process.on('uncaughtException', (error) => {
  logger.error({ error }, '[PROCESO] Error no controlado (Uncaught Exception)');
});

// KAN-124: solo advierte (logger.warn, una vez por proceso) si NODE_ENV no es 'production' — no
// bloquea el arranque, a diferencia de las credenciales de Supabase (KAN-122), porque en
// desarrollo local es normal no tenerla seteada.
app.use(nodeEnvCheckMiddleware);

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
        'script-src': ["'self'", (_req, res) => `'nonce-${(res as express.Response).locals.cspNonce}'`],
        // Tiles de OpenStreetMap para el mapa interactivo del panel admin (corrección de
        // coordenadas de propiedades) — Leaflet en sí está vendorizado en src/admin-dashboard/vendor
        // (sirve como 'self'), solo las imágenes de los tiles vienen de un host externo.
        'img-src': ["'self'", 'data:', 'https://*.tile.openstreetmap.org']
      }
    }
  })
);
// KAN-134: límite explícito (antes quedaba en el default de 100kb de body-parser, nunca
// declarado a propósito) + traducción de los errores de body-parser (payload de más, JSON
// malformado) a una respuesta clara — ver src/utils/bodyWhitelist.ts.
app.use(express.json({ limit: JSON_BODY_SIZE_LIMIT }));
app.use(jsonBodyParseErrorHandler);
app.use(cookieParser());

// KAN-141: liveness/health check para monitoreo de infraestructura (load balancer, orquestador).
// Registrado ANTES del access gate a propósito — un chequeo de infraestructura no debe depender
// de la cookie de acceso privado ni de auth de tenant, o el sistema de monitoreo quedaría ciego
// mientras el gate esté activo. Sin dependencias externas (Supabase, etc.) para no arrastrar su
// latencia/disponibilidad a un simple chequeo de que el proceso está vivo.
app.get('/health', (req, res) => {
  res.status(200).json(buildHealthPayload());
});

// Panel admin (app.admin.brokaza.com): se monta ANTES que el resto del pipeline de tenants
// (access gate, dashboard estático, /api/*) para que, cuando el Host coincide, la request
// quede completamente aislada en su propio router y nunca llegue a la lógica de tenants — y
// viceversa, /admin nunca existe si se le pega desde el dominio normal.
mountAdminRouter(app);

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

// ==========================================
// RUTAS DE API, POR DOMINIO (src/routes/*)
// ==========================================
app.use(systemRouter);
app.use(authRouter);
app.use(profileRouter);
app.use(uploadRouter);
app.use(searchRouter);
app.use(matchesRouter);
app.use(notificationsRouter);
app.use(propertiesRouter);

// KAN-124: manejador de errores global — DEBE quedar como el último app.use(), después de
// mountAdminRouter y de todas las rutas de tenant/API de arriba, para que también atrape errores
// que suben desde adminRouter (AC4) y no solo del pipeline de tenants. Ver src/utils/errorHandler.ts.
app.use(globalErrorHandler);

// ==========================================
// FUNCIÓN PRINCIPAL DE ARRANQUE (MAIN)
// ==========================================

async function main() {
  logger.info('Iniciando Brokaza MVP Multi-Tenant con Dashboard...');

  // Iniciar servicio de cotización de Dólar Blue (dinámico y horaria)
  startDolarService();

  // Iniciar servicio de vencimiento de búsquedas sin match a los 7 días (KAN-41)
  startSearchExpirationService();

  // KAN-137: pool de worker threads para el parseo de Excels subidos — se arranca acá (en vez de
  // lazy en el primer POST /api/upload) para que los workers ya estén levantados y no sumar la
  // latencia de arranque de worker_threads a la primera subida real.
  initExcelParsePool();

  // KAN-78: el notificador consolidado por email (startEmailNotificationService) se eliminó junto
  // con match_queue — corría cada NOTIFICATION_INTERVAL_MINUTES sin hacer nada desde el pivot a
  // matching 100% web (nada escribía filas nuevas en match_queue). El único canal de notificación
  // activo hoy es el del matching ciego (notifyMatchFound, disparado desde routes/search.ts).

  // Levantar servidor Express + WebSocket (KAN-88) sobre el mismo puerto/servidor HTTP.
  const server = http.createServer(app);
  initRealtimeHub(server);

  server.listen(PORT, () => {
    logger.info({ port: PORT }, `DASHBOARD DISPONIBLE EN: http://localhost:${PORT}`);
  });
}

// Iniciar aplicación
main().catch((error) => {
  logger.error({ error }, 'Fallo crítico al iniciar la aplicación');
});
