import * as express from 'express';
import { processExcelBufferWithColumnMap, peekExcelHeaders, syncPropertiesToDatabase } from '../services/excel';
import { resolveColumnMapping, confirmColumnMapping, toColumnMapRecord, ExcelMappingServiceError } from '../services/excelMapping';
import { ExcelMappingField, EXCEL_MAPPING_FIELDS, REQUIRED_EXCEL_MAPPING_FIELDS, EXCEL_MAPPING_FIELDS_VERSION } from '../utils/excelHeaderMatcher';
import { logger } from '../services/logger';
import { getTenantPlanLimits } from '../services/planLimits';

// KAN-215: contrato compartido de MAPPING_FIELDS — el frontend lo consume en vez de hardcodear su
// propia copia (ver docs/evolucion_proyecto/mapping_fields_contract.md). Público, sin
// tenantAuthMiddleware: es metadata estática de negocio, no depende de una sesión de tenant.
// Hallazgo de KAN-76: este endpoint solo existía en el src/routes/upload.ts viejo (KAN-142),
// nunca montado tras el split a routes/*Routes.ts + controllers/* — roto en producción hasta acá.
export function getMappingFields(req: express.Request, res: express.Response) {
  res.json({
    version: EXCEL_MAPPING_FIELDS_VERSION,
    fields: EXCEL_MAPPING_FIELDS,
    required: REQUIRED_EXCEL_MAPPING_FIELDS
  });
}

export async function uploadCatalog(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  try {
    // KAN-84: antes de parsear el archivo completo, resolvemos el mapeo de columnas de cada hoja
    // (mapeo confirmado ya guardado -> heurística de keywords -> IA como re-detección) — si
    // alguna hoja no llega a confianza suficiente, no se procesa nada todavía: se le devuelve al
    // frontend la propuesta de mapeo para que el agente la confirme o corrija (AC4).
    const sheetsHeaders = peekExcelHeaders(req.file.buffer);
    if (sheetsHeaders.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    const mappingsBySignature = new Map<string, Partial<Record<ExcelMappingField, string | null>>>();
    const pendingConfirmations: any[] = [];

    for (const { sheetName, headers } of sheetsHeaders) {
      const resolution = await resolveColumnMapping(tenantId, headers, tenantSupabase);
      if (resolution.status === 'needs_confirmation') {
        pendingConfirmations.push({
          sheetName,
          headers,
          headerSignature: resolution.headerSignature,
          source: resolution.source,
          fields: resolution.fields,
          unresolvedRequiredFields: resolution.unresolvedRequiredFields,
          ambiguousFields: resolution.ambiguousFields
        });
      } else {
        mappingsBySignature.set(resolution.headerSignature, toColumnMapRecord(resolution.fields));
      }
    }

    if (pendingConfirmations.length > 0) {
      logger.warn(
        { tenantId, sheets: pendingConfirmations.map((p: any) => p.sheetName) },
        '[UPLOAD] El mapeo de columnas de una o más hojas requiere confirmación del agente'
      );
      return res.status(200).json({ requiresMappingConfirmation: true, sheets: pendingConfirmations });
    }

    const { properties: catalog, priceParseErrors } = processExcelBufferWithColumnMap(req.file.buffer, mappingsBySignature);
    if (catalog.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    // Fase 1 pre-lanzamiento: cap de cartera del plan (ver src/config/planLimits.ts). syncPropertiesToDatabase
    // reemplaza toda la cartera del tenant (upsert + delete de lo no matcheado, ver services/excel.ts), así
    // que el conteo final ≈ catalog.length — se valida antes de tocar la base.
    const { maxProperties } = await getTenantPlanLimits(tenantId, tenantSupabase);
    if (catalog.length > maxProperties) {
      return res.status(400).json({ error: `El archivo tiene ${catalog.length} propiedades y tu plan permite hasta ${maxProperties}.` });
    }

    // Aislamiento por tenant
    await syncPropertiesToDatabase(catalog, tenantId, tenantSupabase);

    if (priceParseErrors.length > 0) {
      logger.warn(
        { tenantId, priceParseErrors },
        '[UPLOAD] Filas con precio no parseable detectadas al procesar el Excel'
      );
    }

    res.json({ success: true, count: catalog.length, priceParseErrors });
  } catch (error: any) {
    logger.error({ tenantId, err: error.message || error }, '[UPLOAD] Error al procesar subida de Excel');
    res.status(500).json({ error: 'Error interno al procesar el archivo.' });
  }
}

// KAN-84 (AC4): el agente confirma o corrige, desde la UI, el mapeo de columnas propuesto por
// POST /api/upload cuando este respondió `requiresMappingConfirmation`. Recibe de nuevo el mismo
// archivo (multipart) más un campo de texto `mappings` (JSON: `{ [sheetName]: { [field]: header
// | null } }`, una entrada por cada hoja pendiente) y, si el mapeo confirmado resuelve los campos
// requeridos de cada hoja, persiste el mapeo como confirmado y procesa el archivo completo en la
// misma request — no hace falta un tercer round-trip.
export async function confirmMapping(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  let mappingsBySheet: Record<string, Partial<Record<ExcelMappingField, string | null>>>;
  try {
    mappingsBySheet = JSON.parse(String(req.body?.mappings || ''));
  } catch {
    return res.status(400).json({ error: 'El campo "mappings" debe ser un JSON válido con el mapeo confirmado por hoja.' });
  }

  try {
    const sheetsHeaders = peekExcelHeaders(req.file.buffer);
    const mappingsBySignature = new Map<string, Partial<Record<ExcelMappingField, string | null>>>();

    for (const { sheetName, headers } of sheetsHeaders) {
      const fieldMap = mappingsBySheet[sheetName];
      if (fieldMap) {
        const { headerSignature, fields } = await confirmColumnMapping(tenantId, headers, fieldMap, tenantSupabase);
        mappingsBySignature.set(headerSignature, toColumnMapRecord(fields));
        continue;
      }

      // KAN-84: POST /api/upload solo devuelve al frontend las hojas que necesitaron
      // confirmación — una hoja que ya se resolvió sola (heurística/IA) en esa misma corrida
      // nunca aparece en `data.sheets`, así que el frontend no puede mandar un mapeo explícito
      // para ella acá. En vez de rechazar la request, se vuelve a resolver: como esa hoja ya
      // quedó persistida como confirmada en la corrida anterior, esto pega el camino "stored"
      // (sin heurística ni IA de nuevo). Si por algún motivo ya no resuelve, ahí sí es un error
      // real del cliente (mapeo incompleto).
      const resolution = await resolveColumnMapping(tenantId, headers, tenantSupabase);
      if (resolution.status !== 'ready') {
        return res.status(400).json({ error: `Falta el mapeo confirmado para la hoja "${sheetName}".` });
      }
      mappingsBySignature.set(resolution.headerSignature, toColumnMapRecord(resolution.fields));
    }

    const { properties: catalog, priceParseErrors } = processExcelBufferWithColumnMap(req.file.buffer, mappingsBySignature);
    if (catalog.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    // Fase 1 pre-lanzamiento: mismo cap de cartera que uploadCatalog (ver ese handler para el detalle).
    const { maxProperties } = await getTenantPlanLimits(tenantId, tenantSupabase);
    if (catalog.length > maxProperties) {
      return res.status(400).json({ error: `El archivo tiene ${catalog.length} propiedades y tu plan permite hasta ${maxProperties}.` });
    }

    await syncPropertiesToDatabase(catalog, tenantId, tenantSupabase);

    if (priceParseErrors.length > 0) {
      logger.warn(
        { tenantId, priceParseErrors },
        '[UPLOAD] Filas con precio no parseable detectadas al procesar el Excel'
      );
    }

    res.json({ success: true, count: catalog.length, priceParseErrors });
  } catch (error: any) {
    if (error instanceof ExcelMappingServiceError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ tenantId, err: error.message || error }, '[UPLOAD] Error al confirmar mapeo de columnas y procesar Excel');
    res.status(500).json({ error: 'Error interno al procesar el archivo.' });
  }
}
