import { z } from 'zod';
import { EXCEL_MAPPING_FIELDS, type ExcelMappingField } from '../../utils/excelHeaderMatcher';

// BE-06: schema de salida de la sugerencia de mapeo de columnas de Excel (KAN-84) — un array con
// una entrada por campo de negocio conocido. El enum se deriva de EXCEL_MAPPING_FIELDS (fuente
// única de verdad, versionada — ver excelHeaderMatcher.ts#EXCEL_MAPPING_FIELDS_VERSION) en vez de
// listar los 11 campos de nuevo acá, para que ambas listas no puedan desincronizarse.
const excelMappingFieldEnum = EXCEL_MAPPING_FIELDS as unknown as [ExcelMappingField, ...ExcelMappingField[]];

export const ExcelMappingSchema = z.object({
  mapping: z.array(z.object({
    field: z.enum(excelMappingFieldEnum),
    header: z.string().nullable(),
    // z.coerce.number() en vez de z.number(): a diferencia de los enums (que los dos proveedores
    // ya constrainen en la generación), "confidence" es un float libre — si el modelo lo
    // stringifica ("0.9" en vez de 0.9), coercionarlo es una red de seguridad de TIPO, no una
    // decisión de negocio, así que vive acá (en el schema) y no en código de la operación.
    confidence: z.coerce.number()
  }))
});

export type ExcelMappingLlmOutput = z.infer<typeof ExcelMappingSchema>;

// KAN-84: `header` debe ser el texto EXACTO de una de las columnas provistas en el prompt, o
// `null` si ninguna corresponde — se valida/re-resuelve contra los headers reales en
// excelMapping.ts, nunca se confía ciegamente en que la IA no alucine un header inexistente.
export interface ExcelColumnMappingSuggestion {
  field: string;
  header: string | null;
  confidence: number;
}
