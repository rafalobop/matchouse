import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import http from 'http';
import { createApp } from './app';
import { initRealtimeHub } from './services/realtimeHub';
import { startDolarService } from './services/dolar';
import { startSearchExpirationService } from './services/searchExpiration';
import { logger } from './services/logger';
import { initExcelParsePool } from './services/excelParsePool';

const PORT = process.env.PORT || 3000;

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

  const app = createApp();

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
