// KAN-84: heurística de detección de columnas de Excel, extraída y generalizada de la lógica que
// ya vivía inline en `processExcelBuffer` (src/services/excel.ts) — mismos sinónimos/keywords,
// ahora reutilizable tanto por el parser por defecto (sin cambios de comportamiento) como por el
// motor de mapeo por tenant (`excelMapping.ts`), que necesita un puntaje de confianza explícito
// para decidir si reusar la heurística, escalar a IA, o pedirle confirmación al agente.
// Función pura, sin acceso a red/DB, para poder testearla de forma aislada.

export type ExcelMappingField =
  | 'domicilio'
  | 'piso_lote'
  | 'precio'
  | 'expensas'
  | 'dormitorios'
  | 'caracteristicas'
  | 'contacto'
  | 'tipo'
  | 'operacion'
  | 'latitud'
  | 'longitud';

export const EXCEL_MAPPING_FIELDS: ExcelMappingField[] = [
  'domicilio', 'piso_lote', 'precio', 'expensas', 'dormitorios',
  'caracteristicas', 'contacto', 'tipo', 'operacion', 'latitud', 'longitud'
];

// KAN-215: versión del contrato de MAPPING_FIELDS expuesto por `GET /api/upload/mapping-fields`
// (ver src/routes/upload.ts) — el frontend la usa para detectar drift en vez de hardcodear la
// lista de campos (ver docs/evolucion_proyecto/mapping_fields_contract.md). Bumpear a mano
// cualquier vez que cambie `EXCEL_MAPPING_FIELDS` y/o `REQUIRED_EXCEL_MAPPING_FIELDS` (agregar,
// quitar o renombrar un campo) — es la única señal de auditoría de cambios de este contrato.
export const EXCEL_MAPPING_FIELDS_VERSION = 1;

// Únicos dos campos sin los cuales `processExcelBuffer` ya descarta la pestaña entera (ver
// guard `colDomicilio === -1 || colPrecio === -1`) — mismo criterio acá: sin estos dos, no hay
// suficiente confianza para procesar la hoja sin intervención humana.
export const REQUIRED_EXCEL_MAPPING_FIELDS: ExcelMappingField[] = ['domicilio', 'precio'];

const EXACT_CONFIDENCE = 1.0;
const SUBSTRING_CONFIDENCE = 0.7;

interface FieldMatcher {
  field: ExcelMappingField;
  test: (header: string) => boolean;
  confidence: number;
}

// Mismos sinónimos exactos que resolvían `colDomicilio`/`colPisoLote`/etc. en `excel.ts` antes de
// KAN-84 — a propósito no se agregan sinónimos nuevos (ej. "address"/"price" en inglés) para que
// el "camino rápido" (confianza alta -> reusar el parser heurístico existente sin cambios) siga
// siendo exactamente equivalente al comportamiento ya validado por `tests/excel.test.ts`.
const FIELD_MATCHERS: FieldMatcher[] = [
  { field: 'domicilio', test: h => h === 'domicilio', confidence: EXACT_CONFIDENCE },
  { field: 'piso_lote', test: h => h.includes('piso') || h.includes('lote'), confidence: SUBSTRING_CONFIDENCE },
  { field: 'precio', test: h => h === 'precio', confidence: EXACT_CONFIDENCE },
  { field: 'expensas', test: h => h === 'expensas', confidence: EXACT_CONFIDENCE },
  { field: 'dormitorios', test: h => h.includes('dormitorio') || h.includes('dorm'), confidence: SUBSTRING_CONFIDENCE },
  { field: 'caracteristicas', test: h => h.includes('caracteristica') || h.includes('características') || h.includes('descripcion'), confidence: SUBSTRING_CONFIDENCE },
  { field: 'contacto', test: h => h === 'contacto', confidence: EXACT_CONFIDENCE },
  { field: 'tipo', test: h => h === 'tipo', confidence: EXACT_CONFIDENCE },
  { field: 'operacion', test: h => h === 'operacion', confidence: EXACT_CONFIDENCE },
  { field: 'latitud', test: h => h === 'latitud', confidence: EXACT_CONFIDENCE },
  { field: 'longitud', test: h => h === 'longitud', confidence: EXACT_CONFIDENCE }
];

export interface FieldMatchCandidate {
  header: string;
  headerIndex: number;
  confidence: number;
}

export interface FieldMatch {
  field: ExcelMappingField;
  header: string | null;
  headerIndex: number | null;
  confidence: number;
  // true cuando más de un header de la hoja matchea los sinónimos del campo (ej. "Descripción" Y
  // "Características" matchean `caracteristicas`) — el mejor candidato queda elegido igual, pero
  // el llamador debe tratar el campo como poco confiable (AC5, estrategia de ambigüedad).
  ambiguous: boolean;
  candidates: FieldMatchCandidate[];
}

export interface HeuristicMappingResult {
  fields: FieldMatch[];
  // Confianza global, calculada SOLO sobre los campos requeridos (domicilio/precio) — los
  // opcionales no bajan la confianza general si faltan (una propiedad sin "expensas" es normal).
  overallConfidence: number;
  hasAmbiguousFields: boolean;
  hasUnresolvedRequiredFields: boolean;
}

/**
 * Clave de búsqueda estable para reusar un mapeo ya aprendido: normaliza (minúsculas/trim) y
 * ordena alfabéticamente los headers, así una reordenación de columnas en una subida posterior
 * (misma estructura, distinto orden) sigue matcheando la misma firma.
 */
export function computeHeaderSignature(headers: string[]): string {
  return headers
    .map(h => String(h || '').toLowerCase().trim())
    .filter(h => h.length > 0)
    .sort()
    .join('|');
}

/**
 * Detecta, para cada campo de negocio conocido, qué columna(s) de la hoja lo representan mejor,
 * con un puntaje de confianza. No lanza nunca — headers vacíos o sin ningún match reconocible
 * simplemente resuelven en campos `null`/confianza 0, que el llamador (`excelMapping.ts`) decide
 * cómo tratar (escalar a IA, o pedir confirmación manual).
 */
export function matchHeadersHeuristically(headersRaw: string[]): HeuristicMappingResult {
  const headers = headersRaw.map(h => String(h || '').toLowerCase().trim());

  const fields: FieldMatch[] = FIELD_MATCHERS.map(({ field, test, confidence }) => {
    const candidates: FieldMatchCandidate[] = [];
    headers.forEach((header, headerIndex) => {
      if (header && test(header)) {
        candidates.push({ header: headersRaw[headerIndex], headerIndex, confidence });
      }
    });

    if (candidates.length === 0) {
      return { field, header: null, headerIndex: null, confidence: 0, ambiguous: false, candidates: [] };
    }

    const best = candidates[0];
    return {
      field,
      header: best.header,
      headerIndex: best.headerIndex,
      confidence: best.confidence,
      ambiguous: candidates.length > 1,
      candidates
    };
  });

  const requiredFields = fields.filter(f => REQUIRED_EXCEL_MAPPING_FIELDS.includes(f.field));
  const hasUnresolvedRequiredFields = requiredFields.some(f => f.header === null);
  const hasAmbiguousFields = fields.some(f => f.ambiguous);
  const overallConfidence = hasUnresolvedRequiredFields
    ? 0
    : requiredFields.reduce((sum, f) => sum + f.confidence, 0) / requiredFields.length;

  return { fields, overallConfidence, hasAmbiguousFields, hasUnresolvedRequiredFields };
}
