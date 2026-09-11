import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { createIntervalService } from '../utils/intervalService';

const DOLAR_API_URL = 'https://dolarapi.com/v1/dolares/blue';
const FALLBACK_RATE = 1200;

function getCachePath(): string {
  const cacheDir = path.join(process.cwd(), 'cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return path.join(cacheDir, 'dolar_blue.json');
}

interface DolarBlueCache {
  rate: number;
  lastUpdated: string;
}

let currentRate = FALLBACK_RATE;

/**
 * Carga la cotización inicial desde el disco
 */
export function loadCachedRate(): number {
  const cachePath = getCachePath();
  if (fs.existsSync(cachePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as DolarBlueCache;
      if (data && typeof data.rate === 'number') {
        currentRate = data.rate;
        logger.info({ rate: currentRate, cacheTime: data.lastUpdated }, '[DOLAR] Cotización cargada desde caché local.');
        return currentRate;
      }
    } catch (error) {
      logger.error({ error }, '[DOLAR] Error al leer la caché local del dólar.');
    }
  }
  logger.info({ rate: currentRate }, '[DOLAR] No hay caché válida. Utilizando cotización por defecto.');
  return currentRate;
}

/**
 * Retorna la cotización del dólar blue actual en memoria
 */
export function getDolarBlueRate(): number {
  return currentRate;
}

/**
 * Realiza la petición a la API y actualiza la caché si hay cambios
 */
export async function updateDolarRate(): Promise<number> {
  try {
    logger.info('[DOLAR] Consultando cotización del Dólar Blue a DolarAPI...');
    const response = await fetch(DOLAR_API_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json() as { venta: number };
    
    if (data && typeof data.venta === 'number' && data.venta > 0) {
      const newRate = data.venta;
      if (newRate !== currentRate) {
        logger.info({ oldRate: currentRate, newRate }, '[DOLAR] Se detectó fluctuación en la cotización. Actualizando caché.');
        currentRate = newRate;
        const cachePath = getCachePath();
        const cacheData: DolarBlueCache = {
          rate: currentRate,
          lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
      } else {
        logger.info({ rate: currentRate }, '[DOLAR] Cotización sin cambios.');
      }
      return currentRate;
    } else {
      throw new Error('Estructura de respuesta inválida desde DolarAPI');
    }
  } catch (error: any) {
    logger.error({ error: error.message || error, fallback: currentRate }, '[DOLAR] Error al actualizar cotización del dólar. Se conserva el valor anterior.');
    return currentRate;
  }
}

// Intervalo de 1 hora (3600000 ms)
const dolarIntervalService = createIntervalService({
  label: 'DOLAR',
  intervalMs: 3600000,
  task: updateDolarRate
});

/**
 * Inicia el servicio de sincronización horaria de cotización
 */
export function startDolarService(): void {
  // Cargar valor inicial cacheado
  loadCachedRate();

  // Ejecutar primera consulta inmediata asíncrona
  updateDolarRate().catch(err => {
    logger.error({ err }, '[DOLAR] Error en actualización inicial de dólar.');
  });

  dolarIntervalService.start();

  logger.info('[DOLAR] Servicio de actualización horaria iniciado.');
}

/**
 * Detiene el servicio (útil para pruebas y apagado limpio)
 */
export function stopDolarService(): void {
  dolarIntervalService.stop();
  logger.info('[DOLAR] Servicio de actualización detenido.');
}
