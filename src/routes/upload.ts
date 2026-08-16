import express from 'express';
import multer from 'multer';
import { syncPropertiesToDatabase } from '../services/excel';
import { peekExcelHeadersInWorker, parseExcelWithColumnMapInWorker } from '../services/excelParsePool';
import { resolveColumnMapping, confirmColumnMapping, toColumnMapRecord, ExcelMappingServiceError } from '../services/excelMapping';
import { ExcelMappingField } from '../utils/excelHeaderMatcher';
import { broadcastUploadStatus } from '../services/realtimeHub';
import { createDistributedRateLimiter } from '../utils/rateLimit';
import { config } from '../config/env';
import { logger } from '../services/logger';
import { tenantAuthMiddleware } from '../middleware/tenantAuth';

// KAN-142: carga de cartera (Excel) y su conteo, extraído de src/index.ts. Único dominio que
// depende de multer y del pool de workers de parseo (excelParsePool.ts) — ninguna otra ruta del
// dashboard necesita esas dependencias, así que quedan encapsuladas acá.

const upload = multer({
  storage: multer.memoryStorage(),
  // KAN-71: mitigación DoS complementaria al rate limit — sin este límite, memoryStorage()
  // acepta un archivo de cualquier tamaño en memoria del proceso.
  limits: { fileSize: config.uploadMaxFileSizeBytes }
});

// KAN-71/KAN-127: rate limit por tenantId (no por IP) para POST /api/upload — ya está detrás de
// tenantAuthMiddleware, así que la identidad estable a limitar es el tenant, no la IP.
// Distribuido (Postgres) desde KAN-127 — ver src/utils/rateLimit.ts y src/config/env.ts.
const uploadRateLimiter = createDistributedRateLimiter('upload', config.uploadRateLimitMax, config.uploadRateLimitWindowMs);

function handleMulterUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
  // KAN-71: upload.single() envuelto a mano (en vez de pasarlo directo como middleware) para
  // poder capturar el error de multer si el archivo supera uploadMaxFileSizeBytes y responder
  // 413 con un mensaje claro, en vez de dejar que reviente como un 500 genérico sin manejar.
  upload.single('excelFile')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMb = Math.floor(config.uploadMaxFileSizeBytes / (1024 * 1024));
        return res.status(413).json({ error: `El archivo supera el tamaño máximo permitido (${maxMb}MB).` });
      }
      logger.error({ error: err.message, tenantId: (req as any).tenantId }, '[UPLOAD] Error de multer al procesar el archivo subido');
      return res.status(400).json({ error: 'No se pudo procesar el archivo subido.' });
    }
    next();
  });
}

const router = express.Router();

router.post('/api/upload', tenantAuthMiddleware, async (req, res, next) => {
  // KAN-71: rate limit por tenant antes de invertir tiempo/memoria en parsear el archivo.
  const tenantId = (req as any).tenantId;
  if (!(await uploadRateLimiter.check(tenantId))) {
    logger.warn({ tenantId }, '[UPLOAD] Rate limit excedido en POST /api/upload');
    return res.status(429).json({ error: 'Demasiadas subidas de archivo. Esperá un minuto e intentá de nuevo.' });
  }
  next();
}, handleMulterUpload, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  try {
    // KAN-137: peekExcelHeaders/processExcelBufferWithColumnMap (xlsx.read + resolución de
    // columnas) corren en un worker thread — trabajo CPU-bound síncrono que, para un Excel
    // grande, podía notarse como una pausa del event loop afectando a otros tenants concurrentes.
    broadcastUploadStatus(tenantId, 'parsing_headers');
    // KAN-84: antes de parsear el archivo completo, resolvemos el mapeo de columnas de cada hoja
    // (mapeo confirmado ya guardado -> heurística de keywords -> IA como re-detección) — si
    // alguna hoja no llega a confianza suficiente, no se procesa nada todavía: se le devuelve al
    // frontend la propuesta de mapeo para que el agente la confirme o corrija (AC4).
    const sheetsHeaders = await peekExcelHeadersInWorker(req.file.buffer);
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
    const { properties: catalog, priceParseErrors } = await parseExcelWithColumnMapInWorker(req.file.buffer, mappingsBySignature);
    if (catalog.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    broadcastUploadStatus(tenantId, 'syncing_database');
    // Aislamiento por tenant
    await syncPropertiesToDatabase(catalog, tenantId, tenantSupabase);

    if (priceParseErrors.length > 0) {
      logger.warn(
        { tenantId, priceParseErrors },
        '[UPLOAD] Filas con precio no parseable detectadas al procesar el Excel'
      );
    }

    broadcastUploadStatus(tenantId, 'done');
    res.json({ success: true, count: catalog.length, priceParseErrors });
  } catch (error: any) {
    logger.error({ error }, 'Error al procesar subida de Excel');
    // KAN-137: un error del worker (archivo malformado, timeout, worker caído) llega acá como
    // cualquier otro error de la promesa — el pool ya se auto-recupera (ver excelParsePool.ts),
    // así que este catch no necesita distinguir su origen.
    broadcastUploadStatus(tenantId, 'error');
    res.status(500).json({ error: 'Error interno al procesar el archivo.' });
  }
});

// KAN-84 (AC4): el agente confirma o corrige, desde la UI, el mapeo de columnas propuesto por
// POST /api/upload cuando este respondió `requiresMappingConfirmation`. Recibe de nuevo el mismo
// archivo (multipart) más un campo de texto `mappings` (JSON: `{ [sheetName]: { [field]: header
// | null } }`, una entrada por cada hoja pendiente) y, si el mapeo confirmado resuelve los campos
// requeridos de cada hoja, persiste el mapeo como confirmado y procesa el archivo completo en la
// misma request — no hace falta un tercer round-trip.
router.post('/api/upload/confirm-mapping', tenantAuthMiddleware, async (req, res, next) => {
  const tenantId = (req as any).tenantId;
  if (!(await uploadRateLimiter.check(tenantId))) {
    logger.warn({ tenantId }, '[UPLOAD] Rate limit excedido en POST /api/upload/confirm-mapping');
    return res.status(429).json({ error: 'Demasiadas subidas de archivo. Esperá un minuto e intentá de nuevo.' });
  }
  next();
}, handleMulterUpload, async (req, res) => {
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
    broadcastUploadStatus(tenantId, 'parsing_headers');
    const sheetsHeaders = await peekExcelHeadersInWorker(req.file.buffer);
    const mappingsBySignature = new Map<string, Partial<Record<ExcelMappingField, string | null>>>();

    broadcastUploadStatus(tenantId, 'resolving_column_mapping');
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

    broadcastUploadStatus(tenantId, 'parsing_rows');
    const { properties: catalog, priceParseErrors } = await parseExcelWithColumnMapInWorker(req.file.buffer, mappingsBySignature);
    if (catalog.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    broadcastUploadStatus(tenantId, 'syncing_database');
    await syncPropertiesToDatabase(catalog, tenantId, tenantSupabase);

    if (priceParseErrors.length > 0) {
      logger.warn(
        { tenantId, priceParseErrors },
        '[UPLOAD] Filas con precio no parseable detectadas al procesar el Excel'
      );
    }

    broadcastUploadStatus(tenantId, 'done');
    res.json({ success: true, count: catalog.length, priceParseErrors });
  } catch (error: any) {
    if (error instanceof ExcelMappingServiceError) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ error }, 'Error al confirmar mapeo de columnas y procesar Excel');
    broadcastUploadStatus(tenantId, 'error');
    res.status(500).json({ error: 'Error interno al procesar el archivo.' });
  }
});

router.get('/api/catalog', tenantAuthMiddleware, async (req, res) => {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  try {
    const { count, error } = await tenantSupabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (error: any) {
    logger.error({ tenantId, err: error.message }, '[CATALOGO] Error al contar propiedades del tenant');
    res.status(500).json({ error: 'Error interno al obtener el catálogo.' });
  }
});

export default router;
