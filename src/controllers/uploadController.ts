import * as express from 'express';
import { processExcelBufferWithColumnMap, peekExcelHeaders, syncPropertiesToDatabase, Property, PriceParseError, SkippedSheet, PropertyGeocodeFailure } from '../services/excel';
import { validateExcelFile } from '../services/excelValidation';
import { resolveColumnMapping, confirmColumnMapping, toColumnMapRecord, ExcelMappingServiceError } from '../services/excelMapping';
import { ExcelMappingField, EXCEL_MAPPING_FIELDS, REQUIRED_EXCEL_MAPPING_FIELDS, EXCEL_MAPPING_FIELDS_VERSION } from '../utils/excelHeaderMatcher';
import { logger } from '../services/logger';
import { getTenantPlanLimits } from '../services/planLimits';
import { broadcastUploadStatus } from '../services/realtimeHub';

// Detalle del modal de resultado de la subida (KAN-218/220): junto con el
// conteo agregado que ya devolvía la respuesta, se arma el detalle propiedad por propiedad —
// las que se cargaron sin problemas (`loaded`) y las que se cargaron con algún dato faltante o
// directamente no se cargaron (`failed`, con el motivo), uniendo las tres fuentes de fallo que ya
// existían por separado (priceParseErrors, geocodeFailures, skippedSheets) en una sola lista que
// el frontend puede listar tal cual.
export interface UploadFailureDetail {
  sheetName: string;
  address: string | null;
  reason: string;
}

export interface UploadLoadedProperty {
  sheetName: string;
  address: string;
  operation: 'venta' | 'alquiler';
  price: number;
  currency: 'USD' | 'ARS';
}

function buildUploadSummary(
  catalog: Property[],
  priceParseErrors: PriceParseError[],
  skippedSheets: SkippedSheet[],
  geocodeFailures: PropertyGeocodeFailure[]
): { loaded: UploadLoadedProperty[]; failed: UploadFailureDetail[] } {
  const failedAddresses = new Set(priceParseErrors.map(e => `${e.sheetName}::${e.address}`));
  geocodeFailures.forEach(f => failedAddresses.add(`${f.sheetName}::${f.address}`));

  const loaded = catalog
    .filter(p => !failedAddresses.has(`${p.sheet_name}::${p.address}`))
    .map(p => ({ sheetName: p.sheet_name, address: p.address, operation: p.operation, price: p.price, currency: p.currency }));

  const failed: UploadFailureDetail[] = [
    ...priceParseErrors.map(e => ({ sheetName: e.sheetName, address: e.address, reason: `Precio no reconocido ("${e.rawValue}"), se cargó sin precio.` })),
    ...geocodeFailures.map(f => ({ sheetName: f.sheetName, address: f.address, reason: `No se pudo ubicar la dirección en el mapa (${f.reason}), se cargó sin coordenadas.` })),
    ...skippedSheets.map(s => ({ sheetName: s.sheetName, address: null, reason: s.reason }))
  ];

  return { loaded, failed };
}

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

  // KAN-308: valida tamaño/filas ANTES de parsear el archivo completo (mitigación de zip bomb).
  const validation = validateExcelFile({ buffer: req.file.buffer, fileSizeBytes: req.file.size }, tenantId);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
  }

  try {
    // KAN-137: notifica por WS cada etapa real del pipeline a medida que arranca, para que el
    // frontend (useUpload/UploadProgressBar) muestre avance real en vez de un spinner ciego.
    broadcastUploadStatus(tenantId, 'parsing_headers');

    // KAN-84: antes de parsear el archivo completo, resolvemos el mapeo de columnas de cada hoja
    // (mapeo confirmado ya guardado -> heurística de keywords -> IA como re-detección) — si
    // alguna hoja no llega a confianza suficiente, no se procesa nada todavía: se le devuelve al
    // frontend la propuesta de mapeo para que el agente la confirme o corrija (AC4).
    const sheetsHeaders = peekExcelHeaders(req.file.buffer);
    if (sheetsHeaders.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    broadcastUploadStatus(tenantId, 'resolving_column_mapping');

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

    broadcastUploadStatus(tenantId, 'parsing_rows');
    const { properties: catalog, priceParseErrors, skippedSheets } = processExcelBufferWithColumnMap(req.file.buffer, mappingsBySignature);
    if (catalog.length === 0) {
      broadcastUploadStatus(tenantId, 'error');
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    // Fase 1 pre-lanzamiento: cap de cartera del plan (ver src/config/planLimits.ts). syncPropertiesToDatabase
    // reemplaza toda la cartera del tenant (upsert + delete de lo no matcheado, ver services/excel.ts), así
    // que el conteo final ≈ catalog.length — se valida antes de tocar la base.
    const { maxProperties } = await getTenantPlanLimits(tenantId, tenantSupabase);
    if (catalog.length > maxProperties) {
      broadcastUploadStatus(tenantId, 'error');
      return res.status(400).json({ error: `El archivo tiene ${catalog.length} propiedades y tu plan permite hasta ${maxProperties}.` });
    }

    await runSyncStageAndRespond(res, tenantId, tenantSupabase, catalog, priceParseErrors, skippedSheets);
  } catch (error: any) {
    logger.error({ tenantId, err: error.message || error }, '[UPLOAD] Error al procesar subida de Excel');
    broadcastUploadStatus(tenantId, 'error');
    res.status(500).json({ error: 'Error interno al procesar el archivo.' });
  }
}

// KAN-338: hasta acá, `syncPropertiesToDatabase` (geocoding secuencial real, ~1 req/seg contra
// Nominatim — no se puede paralelizar sin violar su política de uso, ver geocoding.ts) corría
// DENTRO de la misma respuesta HTTP. Con una cartera nueva de 50+ filas sin coordenadas cacheadas,
// eso son 55-110+ segundos — más que `UPLOAD_TIMEOUT_MS` (60s) del lado de `brokaza-frontend`,
// que aborta el fetch pensando que fue un timeout de red cuando en realidad el backend seguía
// procesando (y probablemente terminaba guardando la cartera igual, sin que el agente se entere).
//
// Fix: la respuesta HTTP se manda ACÁ (antes del tramo lento), y el resultado final (o el error)
// viaja por el WebSocket que ya existía para el progreso (`broadcastUploadStatus`, KAN-137) en la
// etapa 'done'/'error', con el mismo payload que antes iba en el body de la respuesta síncrona
// (`count`/`priceParseErrors`/`loaded`/`failed`). Como la función sigue haciendo `await` de todo
// esto (no es un "fire and forget" desconectado), no hay condición de carrera para testear: los
// tests pueden seguir haciendo `await uploadCatalog(...)` y ver el resultado final vía el mock de
// `broadcastUploadStatus`, sin necesidad de sleeps ni de esperar un segundo tick.
//
// Pendiente explícito para @frontend (no forma parte de este ticket): `brokaza-frontend` todavía
// espera el resultado final (`loaded`/`failed`/`count`) en el body de la respuesta HTTP — con este
// cambio, esa respuesta ahora llega vacía de esos datos (`{ accepted: true }`) apenas arranca el
// tramo lento. Necesita escuchar la etapa 'done'/'error' del WS (`upload_status`) para el
// resultado real, no solo para la barra de progreso.
async function runSyncStageAndRespond(
  res: express.Response,
  tenantId: string,
  tenantSupabase: any,
  catalog: Property[],
  priceParseErrors: PriceParseError[],
  skippedSheets: SkippedSheet[]
): Promise<void> {
  broadcastUploadStatus(tenantId, 'syncing_database');
  res.status(202).json({
    accepted: true,
    message: 'Tu cartera se está sincronizando. Te vamos a avisar cuando termine.'
  });

  try {
    const { geocodeFailures } = await syncPropertiesToDatabase(catalog, tenantId, tenantSupabase);

    if (priceParseErrors.length > 0) {
      logger.warn(
        { tenantId, priceParseErrors },
        '[UPLOAD] Filas con precio no parseable detectadas al procesar el Excel'
      );
    }

    const { loaded, failed } = buildUploadSummary(catalog, priceParseErrors, skippedSheets, geocodeFailures);
    broadcastUploadStatus(tenantId, 'done', { count: catalog.length, priceParseErrors, loaded, failed });
  } catch (error: any) {
    logger.error({ tenantId, err: error.message || error }, '[UPLOAD] Error al sincronizar la cartera tras responder al cliente');
    broadcastUploadStatus(tenantId, 'error');
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

  // KAN-308: valida tamaño/filas ANTES de parsear el archivo completo (mitigación de zip bomb).
  const validation = validateExcelFile({ buffer: req.file.buffer, fileSizeBytes: req.file.size }, tenantId);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
  }

  let mappingsBySheet: Record<string, Partial<Record<ExcelMappingField, string | null>>>;
  try {
    mappingsBySheet = JSON.parse(String(req.body?.mappings || ''));
  } catch {
    return res.status(400).json({ error: 'El campo "mappings" debe ser un JSON válido con el mapeo confirmado por hoja.' });
  }

  try {
    broadcastUploadStatus(tenantId, 'parsing_headers');
    const sheetsHeaders = peekExcelHeaders(req.file.buffer);
    broadcastUploadStatus(tenantId, 'resolving_column_mapping');
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
        broadcastUploadStatus(tenantId, 'error');
        return res.status(400).json({ error: `Falta el mapeo confirmado para la hoja "${sheetName}".` });
      }
      mappingsBySignature.set(resolution.headerSignature, toColumnMapRecord(resolution.fields));
    }

    broadcastUploadStatus(tenantId, 'parsing_rows');
    const { properties: catalog, priceParseErrors, skippedSheets } = processExcelBufferWithColumnMap(req.file.buffer, mappingsBySignature);
    if (catalog.length === 0) {
      broadcastUploadStatus(tenantId, 'error');
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    // Fase 1 pre-lanzamiento: mismo cap de cartera que uploadCatalog (ver ese handler para el detalle).
    const { maxProperties } = await getTenantPlanLimits(tenantId, tenantSupabase);
    if (catalog.length > maxProperties) {
      broadcastUploadStatus(tenantId, 'error');
      return res.status(400).json({ error: `El archivo tiene ${catalog.length} propiedades y tu plan permite hasta ${maxProperties}.` });
    }

    // KAN-338: mismo fix que uploadCatalog — ver comentario de runSyncStageAndRespond.
    await runSyncStageAndRespond(res, tenantId, tenantSupabase, catalog, priceParseErrors, skippedSheets);
  } catch (error: any) {
    broadcastUploadStatus(tenantId, 'error');
    if (error instanceof ExcelMappingServiceError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ tenantId, err: error.message || error }, '[UPLOAD] Error al confirmar mapeo de columnas y procesar Excel');
    res.status(500).json({ error: 'Error interno al procesar el archivo.' });
  }
}
