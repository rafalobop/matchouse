import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as serviceRoleSupabase } from './supabase';
import { logger } from './logger';
import {
  ExcelMappingField,
  EXCEL_MAPPING_FIELDS,
  REQUIRED_EXCEL_MAPPING_FIELDS,
  computeHeaderSignature,
  matchHeadersHeuristically,
  HeuristicMappingResult,
  FieldMatch
} from '../utils/excelHeaderMatcher';
import { suggestExcelColumnMapping, ExcelColumnMappingSuggestion } from './ai';

export class ExcelMappingServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ExcelMappingServiceError';
  }
}

// KAN-84 (AC2): criterio de confianza explícito — por debajo de este umbral, la heurística de
// keywords NO se usa directamente y se escala a IA (re-detección). Elegido alto (0.75) porque un
// falso positivo acá significa cargar propiedades con datos en la columna equivocada sin que
// nadie lo note.
export const HEURISTIC_CONFIDENCE_THRESHOLD = 0.75;

// KAN-84 (AC5): confianza mínima por campo individual para aceptar la sugerencia de la IA sin
// intervención humana — más laxo que el umbral heurístico porque la IA ya es un fallback (si
// tampoco alcanza esto, no queda otra que pedirle confirmación al agente).
export const AI_FIELD_CONFIDENCE_THRESHOLD = 0.6;

export interface ResolvedFieldMapping {
  field: ExcelMappingField;
  header: string | null;
  confidence: number;
  ambiguous: boolean;
  candidates: { header: string; confidence: number }[];
}

interface StoredMappingRow {
  header_signature: string;
  column_mapping: ResolvedFieldMapping[];
  source: 'heuristic' | 'ai' | 'manual';
  confirmed: boolean;
  confidence: number | null;
}

export type ColumnMappingResolution =
  | {
      status: 'ready';
      source: 'stored' | 'heuristic' | 'ai';
      headerSignature: string;
      fields: ResolvedFieldMapping[];
    }
  | {
      status: 'needs_confirmation';
      source: 'heuristic' | 'ai';
      headerSignature: string;
      fields: ResolvedFieldMapping[];
      unresolvedRequiredFields: ExcelMappingField[];
      ambiguousFields: ExcelMappingField[];
    };

function toResolvedFields(heuristic: HeuristicMappingResult): ResolvedFieldMapping[] {
  return heuristic.fields.map((f: FieldMatch) => ({
    field: f.field,
    header: f.header,
    confidence: f.confidence,
    ambiguous: f.ambiguous,
    candidates: f.candidates.map(c => ({ header: c.header, confidence: c.confidence }))
  }));
}

// Combina la sugerencia de la IA con los headers reales de la hoja: valida que cada `header`
// devuelto exista de verdad entre los headers provistos (nunca confía ciegamente en que la IA no
// alucinó un nombre de columna), y aplica AI_FIELD_CONFIDENCE_THRESHOLD por campo.
function resolveAiFields(suggestions: ExcelColumnMappingSuggestion[], headersRaw: string[]): ResolvedFieldMapping[] {
  const headersLower = headersRaw.map(h => String(h || '').toLowerCase().trim());

  return suggestions.map((s): ResolvedFieldMapping => {
    const field = s.field as ExcelMappingField;
    const headerIndex = s.header ? headersLower.indexOf(s.header.toLowerCase().trim()) : -1;
    const validHeader = headerIndex !== -1 ? headersRaw[headerIndex] : null;
    const confidence = validHeader ? Math.max(0, Math.min(1, s.confidence)) : 0;

    return {
      field,
      header: confidence >= AI_FIELD_CONFIDENCE_THRESHOLD ? validHeader : null,
      confidence,
      ambiguous: false,
      candidates: validHeader ? [{ header: validHeader, confidence }] : []
    };
  });
}

async function getStoredMapping(tenantId: string, headerSignature: string, client: SupabaseClient): Promise<StoredMappingRow | null> {
  const { data, error } = await client
    .from('tenant_excel_mappings')
    .select('header_signature, column_mapping, source, confirmed, confidence')
    .eq('tenant_id', tenantId)
    .eq('header_signature', headerSignature)
    .maybeSingle();

  if (error) {
    throw new ExcelMappingServiceError(`No se pudo leer el mapeo guardado del tenant: ${error.message}`, error);
  }
  return (data as StoredMappingRow | null) ?? null;
}

async function upsertMapping(
  tenantId: string,
  headerSignature: string,
  fields: ResolvedFieldMapping[],
  source: 'heuristic' | 'ai' | 'manual',
  confirmed: boolean,
  overallConfidence: number,
  client: SupabaseClient
): Promise<void> {
  const { error } = await client
    .from('tenant_excel_mappings')
    .upsert(
      {
        tenant_id: tenantId,
        header_signature: headerSignature,
        column_mapping: fields,
        source,
        confirmed,
        confidence: overallConfidence,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'tenant_id,header_signature' }
    );

  if (error) {
    throw new ExcelMappingServiceError(`No se pudo guardar el mapeo de columnas: ${error.message}`, error);
  }
}

// Best-effort: un fallo al persistir el mapeo (aprendizaje futuro) no debe tirar abajo la
// resolución en curso — el mapeo ya calculado sigue siendo válido para ESTA subida.
async function upsertMappingBestEffort(
  tenantId: string,
  headerSignature: string,
  fields: ResolvedFieldMapping[],
  source: 'heuristic' | 'ai' | 'manual',
  confirmed: boolean,
  overallConfidence: number,
  client: SupabaseClient
): Promise<void> {
  try {
    await upsertMapping(tenantId, headerSignature, fields, source, confirmed, overallConfidence, client);
  } catch (error: any) {
    logger.error({ tenantId, headerSignature, error: error.message || error }, '[EXCEL MAPPING] No se pudo persistir el mapeo (se sigue usando el resuelto en memoria)');
  }
}

function unresolvedRequired(fields: ResolvedFieldMapping[]): ExcelMappingField[] {
  return REQUIRED_EXCEL_MAPPING_FIELDS.filter(f => !fields.find(rf => rf.field === f)?.header);
}

function ambiguous(fields: ResolvedFieldMapping[]): ExcelMappingField[] {
  return fields.filter(f => f.ambiguous).map(f => f.field);
}

/**
 * Resuelve el mapeo de columnas de una hoja para un tenant (KAN-84), en cascada:
 * 1. Mapeo ya CONFIRMADO por el agente para esta misma estructura de columnas (`headerSignature`)
 *    -> se reusa directo, sin heurística ni IA (AC1: la tabla se usa como fuente de verdad).
 * 2. Heurística de keywords (barata, sin red) -> si resuelve los campos requeridos con confianza
 *    >= HEURISTIC_CONFIDENCE_THRESHOLD y sin ambigüedad, se usa y se persiste como confirmada
 *    automáticamente (AC2: criterio de confianza definido para decidir IA vs. manual).
 * 3. Si la heurística no alcanza (headers no reconocidos / ambiguos) -> se escala a IA (AC3:
 *    re-detección con coincidencias parciales). Si la IA resuelve con confianza suficiente por
 *    campo, se usa y se persiste como confirmada.
 * 4. Si ni la heurística ni la IA alcanzan confianza suficiente -> `needs_confirmation` (AC4/AC5):
 *    se persiste sin confirmar, y el llamador (POST /api/upload) debe exponerlo a la UI para que
 *    el agente confirme o corrija antes de procesar el archivo.
 */
export async function resolveColumnMapping(
  tenantId: string,
  headers: string[],
  client: SupabaseClient = serviceRoleSupabase,
  aiSuggestFn: (headers: string[]) => Promise<ExcelColumnMappingSuggestion[]> = suggestExcelColumnMapping
): Promise<ColumnMappingResolution> {
  const headerSignature = computeHeaderSignature(headers);

  const stored = await getStoredMapping(tenantId, headerSignature, client);
  if (stored && stored.confirmed) {
    return { status: 'ready', source: 'stored', headerSignature, fields: stored.column_mapping };
  }

  const heuristic = matchHeadersHeuristically(headers);
  if (heuristic.overallConfidence >= HEURISTIC_CONFIDENCE_THRESHOLD && !heuristic.hasAmbiguousFields && !heuristic.hasUnresolvedRequiredFields) {
    const fields = toResolvedFields(heuristic);
    await upsertMappingBestEffort(tenantId, headerSignature, fields, 'heuristic', true, heuristic.overallConfidence, client);
    return { status: 'ready', source: 'heuristic', headerSignature, fields };
  }

  let aiFields: ResolvedFieldMapping[] | null = null;
  try {
    const suggestions = await aiSuggestFn(headers);
    if (suggestions.length > 0) {
      aiFields = resolveAiFields(suggestions, headers);
    }
  } catch (error: any) {
    logger.error({ tenantId, headerSignature, error: error.message || error }, '[EXCEL MAPPING] La sugerencia de IA para el mapeo de columnas falló');
  }

  if (aiFields) {
    const aiUnresolved = unresolvedRequired(aiFields);
    const aiAmbiguous = ambiguous(aiFields);
    if (aiUnresolved.length === 0 && aiAmbiguous.length === 0) {
      const overallConfidence = aiFields
        .filter(f => REQUIRED_EXCEL_MAPPING_FIELDS.includes(f.field))
        .reduce((sum, f) => sum + f.confidence, 0) / REQUIRED_EXCEL_MAPPING_FIELDS.length;
      await upsertMappingBestEffort(tenantId, headerSignature, aiFields, 'ai', true, overallConfidence, client);
      return { status: 'ready', source: 'ai', headerSignature, fields: aiFields };
    }
  }

  // Ni la heurística ni la IA (o la IA no estuvo disponible) resolvieron con confianza suficiente.
  const fallbackFields = aiFields ?? toResolvedFields(heuristic);
  const source: 'heuristic' | 'ai' = aiFields ? 'ai' : 'heuristic';
  await upsertMappingBestEffort(tenantId, headerSignature, fallbackFields, source, false, heuristic.overallConfidence, client);

  return {
    status: 'needs_confirmation',
    source,
    headerSignature,
    fields: fallbackFields,
    unresolvedRequiredFields: unresolvedRequired(fallbackFields),
    ambiguousFields: ambiguous(fallbackFields)
  };
}

/**
 * Persiste el mapeo confirmado/corregido por el agente vía la UI (AC4). `fields` es el mapeo
 * final tal como lo confirmó/corrigió — se guarda con `source: 'manual'` y `confirmed: true`
 * independientemente de qué había sugerido la heurística o la IA antes.
 */
export async function confirmColumnMapping(
  tenantId: string,
  headers: string[],
  fields: Partial<Record<ExcelMappingField, string | null>>,
  client: SupabaseClient = serviceRoleSupabase
): Promise<{ headerSignature: string; fields: ResolvedFieldMapping[] }> {
  const headerSignature = computeHeaderSignature(headers);
  const headersLower = headers.map(h => String(h || '').toLowerCase().trim());

  // KAN-302: `resolveColumnMapping` ya persiste (best-effort, sin confirmar) los 11 campos
  // resueltos por heurística/IA antes de pedirle confirmación al agente — el agente solo corrige
  // desde la UI los campos puntuales que quedaron mal/sin resolver, no reenvía los 11 de nuevo. Si
  // acá solo se toman en cuenta las claves presentes en `fields`, cualquier campo que ya estaba
  // bien resuelto (y por eso no vino en la corrección) se pierde del mapeo confirmado. Se parte
  // entonces del mapeo ya guardado para esta firma de headers (confirmado o no) y se pisa con lo
  // que venga explícito en `fields`.
  const previouslyResolved = await getStoredMapping(tenantId, headerSignature, client);
  const baseFields = new Map<ExcelMappingField, string | null>(
    EXCEL_MAPPING_FIELDS.map(field => [field, null])
  );
  for (const f of previouslyResolved?.column_mapping ?? []) {
    baseFields.set(f.field, f.header);
  }
  for (const [field, header] of Object.entries(fields)) {
    baseFields.set(field as ExcelMappingField, header ?? null);
  }

  const resolvedFields: ResolvedFieldMapping[] = Array.from(baseFields.entries()).map(([field, header]) => {
    const headerIndex = header ? headersLower.indexOf(header.toLowerCase().trim()) : -1;
    const validHeader = headerIndex !== -1 ? headers[headerIndex] : null;
    return {
      field,
      header: validHeader,
      confidence: validHeader ? 1 : 0,
      ambiguous: false,
      candidates: validHeader ? [{ header: validHeader, confidence: 1 }] : []
    };
  });

  const missingRequired = unresolvedRequired(resolvedFields);
  if (missingRequired.length > 0) {
    throw new ExcelMappingServiceError(`El mapeo confirmado no resuelve los campos requeridos: ${missingRequired.join(', ')}`);
  }

  await upsertMapping(tenantId, headerSignature, resolvedFields, 'manual', true, 1, client);
  return { headerSignature, fields: resolvedFields };
}

/** Convierte `fields` (formato de columna_mapping) a `{field: header}` para `processExcelBufferWithColumnMap`. */
export function toColumnMapRecord(fields: ResolvedFieldMapping[]): Partial<Record<ExcelMappingField, string | null>> {
  const record: Partial<Record<ExcelMappingField, string | null>> = {};
  for (const f of fields) {
    record[f.field] = f.header;
  }
  return record;
}
