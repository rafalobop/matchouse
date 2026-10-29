import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import http from 'http';
import { createApp } from './app';
import { initRealtimeHub } from './services/realtimeHub';
import { startDolarService, stopDolarService } from './services/dolar';
import { startSearchExpirationService, stopSearchExpirationService } from './services/searchExpiration';
import { startReengagementService, stopReengagementService } from './services/reengagement';
import { startLicenseValidationRetryService, stopLicenseValidationRetryService } from './services/licenseValidationRetry';
import { logger } from './services/logger';
import { initExcelParsePool } from './services/excelParsePool';
import { initTracing, shutdownTracing } from './services/tracing';

const PORT = process.env.PORT || 3000;

// KAN-307: apagado ordenado ante SIGTERM/SIGINT — timeout total para esperar las solicitudes en
// curso y para cada job de background (si un job no termina de detenerse dentro de este tiempo, se
// da por forzado y se loguea, en vez de bloquear el shutdown indefinidamente).
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Ejecuta la función `stop` de un job de background con un timeout defensivo: si tarda más que
 * `timeoutMs` (o lanza/rechaza), se loguea y se continúa igual — un job colgado no puede bloquear
 * el resto del apagado. `stop` puede ser sync (los 4 jobs de setInterval) o async (BE-03:
 * shutdownTracing, que espera a que el exporter drene su buffer) — `Promise.resolve().then(stop)`
 * cubre ambos casos sin cambiar el contrato para los llamadores existentes.
 */
function stopJobWithTimeout(name: string, stop: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.error({ job: name }, '[SHUTDOWN] El job de background no respondió dentro del timeout; se fuerza su cierre.');
      resolve();
    }, timeoutMs);

    Promise.resolve()
      .then(() => stop())
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((error) => {
        clearTimeout(timer);
        logger.error({ error, job: name }, '[SHUTDOWN] Error al detener el job de background.');
        resolve();
      });
  });
}

function setupGracefulShutdown(server: http.Server): void {
  let isShuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, '[SHUTDOWN] Señal recibida, iniciando apagado ordenado.');

    // Detiene los 4 jobs de background en paralelo mediante sus funciones stop, más el drenaje
    // del tracer de Langfuse (BE-03) — mismo patrón de timeout defensivo, para no perder spans
    // bufferizados ante un apagado ordenado.
    const stopJobs = Promise.all([
      stopJobWithTimeout('dolar', stopDolarService, SHUTDOWN_TIMEOUT_MS),
      stopJobWithTimeout('search-expiration', stopSearchExpirationService, SHUTDOWN_TIMEOUT_MS),
      stopJobWithTimeout('reengagement', stopReengagementService, SHUTDOWN_TIMEOUT_MS),
      stopJobWithTimeout('license-validation-retry', stopLicenseValidationRetryService, SHUTDOWN_TIMEOUT_MS),
      stopJobWithTimeout('tracing', shutdownTracing, SHUTDOWN_TIMEOUT_MS),
    ]);

    // Deja de aceptar nuevas conexiones; el callback de close() sólo se dispara cuando terminan
    // las solicitudes/conexiones en curso.
    const closeServer = new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          logger.error({ error: err }, '[SHUTDOWN] Error al cerrar el servidor HTTP.');
        }
        resolve();
      });
    });

    const closeTimeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
    });

    Promise.all([stopJobs, Promise.race([closeServer, closeTimeout])]).then(([, closeResult]) => {
      if (closeResult === 'timeout') {
        logger.error('[SHUTDOWN] Timeout de 10s alcanzado esperando solicitudes en curso; se fuerza el cierre del servidor.');
      }
      logger.info('[SHUTDOWN] Apagado ordenado completado.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[PROCESO] Promesa no capturada (Unhandled Rejection)');
});

process.on('uncaughtException', (error) => {
  logger.error({ error }, '[PROCESO] Error no controlado (Uncaught Exception)');
});

// ==========================================
// FUNCIÓN PRINCIPAL DE ARRANQUE (MAIN)
// ==========================================

async function main() {
  logger.info('Iniciando Brokaza MVP Multi-Tenant con Dashboard...');

  // BE-03: tracing de POST /api/search. No-op si faltan LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY.
  initTracing();

  const app = createApp();

  // Iniciar servicio de cotización de Dólar Blue (dinámico y horaria)
  startDolarService();

  // Iniciar servicio de vencimiento de búsquedas sin match a los 7 días (KAN-41)
  startSearchExpirationService();

  // Iniciar servicio de avisos de reenganche ("¿la renovás?") sobre búsquedas ya vencidas sin match (KAN-58)
  startReengagementService();

  // Iniciar servicio de sincronización del padrón de matriculados y reintento de validación de
  // cuentas pendientes (KAN-306)
  startLicenseValidationRetryService();

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

  setupGracefulShutdown(server);
}

// Iniciar aplicación
main().catch((error) => {
  logger.error({ error }, 'Fallo crítico al iniciar la aplicación');
});
