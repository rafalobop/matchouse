// Boilerplate compartido de "job periódico con setInterval", antes reimplementado por separado en
// dolar.ts/searchExpiration.ts/reengagement.ts/licenseValidationRetry.ts (cada uno con su propio
// par startXService/stopXService + variable de módulo para el handle del timer).

import { logger } from '../services/logger';

export interface IntervalServiceOptions {
  label: string;
  intervalMs: number;
  task: () => Promise<unknown>;
}

export interface IntervalService {
  start: () => void;
  stop: () => void;
}

export function createIntervalService(options: IntervalServiceOptions): IntervalService {
  const { label, intervalMs, task } = options;
  let timer: NodeJS.Timeout | null = null;

  return {
    start() {
      if (timer) {
        clearInterval(timer);
      }
      timer = setInterval(() => {
        task().catch((err: any) => {
          logger.error({ error: err?.message || err }, `[${label}] Fallo inesperado en la corrida periódica.`);
        });
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}
