import pino from 'pino';
import { buildLogRedactionConfig } from '../config/logRedaction';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined, // Remueve pid y hostname para mayor claridad
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: buildLogRedactionConfig() // KAN-135: redacta PII (email, ip, domicilio, etc.) en logs de texto plano
});
