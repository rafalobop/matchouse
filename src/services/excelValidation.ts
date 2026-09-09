// KAN-308: valida un Excel subido ANTES de que se materialice su contenido completo (peekExcelHeaders/
// processExcelBufferWithColumnMap en excel.ts, ambos vía xlsx.utils.sheet_to_json), mitigando el riesgo
// de "zip bomb" (un .xlsx chico que decomprime a una cantidad desproporcionada de filas/celdas).
// Patrón Estrategia simplificado (AC5): cada regla de rechazo es una `ExcelValidationStrategy`
// independiente, evaluada en orden por `validateExcelFile` con corte en la primera que falle.
import * as xlsx from 'xlsx';
import { logger } from './logger';
import { config } from '../config/env';

export interface ExcelValidationInput {
  buffer: Buffer;
  fileSizeBytes: number;
}

export interface ExcelValidationResult {
  valid: boolean;
  reason?: string;
}

export interface ExcelValidationStrategy {
  name: string;
  validate(input: ExcelValidationInput): ExcelValidationResult;
}

// Defensa en profundidad: en el camino real (POST /api/upload) multer ya rechaza con 413 antes de
// que este código corra (ver uploadRoutes.ts#handleUpload, config.uploadMaxFileSizeBytes) — esta
// estrategia deja la regla de negocio testeable de forma aislada y protege a cualquier otro
// consumidor futuro de `validateExcelFile` que no pase por ese middleware.
const fileSizeStrategy: ExcelValidationStrategy = {
  name: 'file-size',
  validate({ fileSizeBytes }) {
    if (fileSizeBytes > config.uploadMaxFileSizeBytes) {
      const maxMb = Math.floor(config.uploadMaxFileSizeBytes / (1024 * 1024));
      return { valid: false, reason: `El archivo supera el tamaño máximo permitido (${maxMb}MB).` };
    }
    return { valid: true };
  }
};

// Lee `!ref` (rango usado de la hoja, disponible apenas termina xlsx.read()) en vez de llamar
// sheet_to_json — evita materializar cada celda de una hoja con una cantidad de filas abusiva
// antes de decidir si el archivo se rechaza.
const rowCountStrategy: ExcelValidationStrategy = {
  name: 'row-count',
  validate({ buffer }) {
    const workbook = xlsx.read(buffer, { type: 'buffer' });

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const ref = worksheet['!ref'];
      if (!ref) continue;

      const range = xlsx.utils.decode_range(ref);
      const rowCount = range.e.r - range.s.r + 1;

      if (rowCount > config.excelMaxRows) {
        return {
          valid: false,
          reason: `La hoja "${sheetName}" tiene ${rowCount} filas, supera el límite de ${config.excelMaxRows} filas por hoja.`
        };
      }
    }

    return { valid: true };
  }
};

const strategies: ExcelValidationStrategy[] = [fileSizeStrategy, rowCountStrategy];

/**
 * Corre las estrategias de validación en orden y corta en la primera que rechace el archivo.
 * Loguea el evento de rechazo (AC4) con la estrategia y el motivo antes de devolver el resultado.
 */
export function validateExcelFile(input: ExcelValidationInput, tenantId?: string): ExcelValidationResult {
  for (const strategy of strategies) {
    const result = strategy.validate(input);
    if (!result.valid) {
      logger.warn(
        { tenantId, strategy: strategy.name, reason: result.reason },
        '[EXCEL-VALIDATION] Archivo Excel rechazado.'
      );
      return result;
    }
  }
  return { valid: true };
}
