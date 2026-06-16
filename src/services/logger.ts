import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined, // Remueve pid y hostname para mayor claridad
  timestamp: pino.stdTimeFunctions.isoTime
});
