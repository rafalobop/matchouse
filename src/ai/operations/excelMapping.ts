import { logger } from '../../services/logger';
import { FallbackProvider } from '../providers/fallbackProvider';
import { AllProvidersFailedError } from '../providers/types';
import { ExcelMappingSchema, ExcelColumnMappingSuggestion } from '../schemas/excelMapping.schema';
import { SYSTEM_INSTRUCTIONS_EXCEL_MAPPING, EXCEL_MAPPING_PROMPT_VERSION } from '../prompts';
import { escapeForXmlTag } from '../promptSafety';

// BE-11: cada header se escapa ANTES de stringificar el array — `JSON.stringify` no escapa `<`/`>`
// (solo caracteres de control/comillas), así que un header malicioso con un cierre de tag literal
// seguiría rompiendo el wrapper si solo se stringificara. El escape no afecta el emparejamiento
// downstream: `resolveAiFields` (services/excelMapping.ts) valida el `header` que devuelve la IA
// contra los headers REALES (sin escapar) — si el modelo llegara a devolver el header escapado tal
// cual, simplemente no matchea y ese campo degrada a `null` (mismo fail-soft que ya existía para
// cualquier header alucinado).
export function buildUserPrompt(headers: string[]): string {
  return `Estas son las columnas (headers) de una hoja de cálculo Excel, en el orden en que aparecen, dentro de las etiquetas <EXCEL_HEADERS> y </EXCEL_HEADERS>:
<EXCEL_HEADERS>
${JSON.stringify(headers.map(escapeForXmlTag))}
</EXCEL_HEADERS>`;
}

// KAN-84: usado por excelMapping.ts (servicio, no esta operación — nombre compartido histórico)
// cuando la heurística de keywords no resuelve los campos requeridos con confianza suficiente.
// A diferencia del resto de las operaciones, NO devuelve un objeto por defecto ante el fallo
// total — devuelve `[]` para que el llamador distinga "la IA no pudo sugerir nada" de "la IA
// sugirió que ningún header corresponde a ningún campo" y trate el primer caso como "requiere
// confirmación manual" en vez de como una sugerencia válida vacía.
export async function suggestExcelColumnMapping(
  fallbackProvider: FallbackProvider,
  headers: string[],
  tenantId?: string
): Promise<ExcelColumnMappingSuggestion[]> {
  try {
    const raw = await fallbackProvider.generateStructured({
      op: 'map-excel-columns',
      promptVersion: EXCEL_MAPPING_PROMPT_VERSION,
      system: SYSTEM_INSTRUCTIONS_EXCEL_MAPPING,
      user: buildUserPrompt(headers),
      schema: ExcelMappingSchema,
      tenantId,
      tracingInput: headers
    });
    return raw.mapping;
  } catch (error) {
    if (error instanceof AllProvidersFailedError) {
      logger.error('[AI] Todas las estrategias de mapeo de columnas de Excel fallaron.');
      return [];
    }
    throw error;
  }
}
