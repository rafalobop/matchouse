import { logger } from '../../services/logger';
import { FallbackProvider } from '../providers/fallbackProvider';
import { AllProvidersFailedError } from '../providers/types';
import { SegmentSchema, SegmentLlmOutput } from '../schemas/segment.schema';
import { SYSTEM_INSTRUCTIONS_SEGMENTER, SEGMENTER_PROMPT_VERSION } from '../prompts';

function buildUserPrompt(messageTexto: string): string {
  return `Analiza el texto provisto estrictamente dentro de las etiquetas <USER_TEXT> y </USER_TEXT>:
<USER_TEXT>
${messageTexto}
</USER_TEXT>`;
}

// Decisión de negocio ("si el LLM devolvió menos de 2 segmentos, tratar el mensaje completo como
// una sola búsqueda"), no estructural — el schema ya garantiza que `segments` es un array de
// strings; esto decide qué hacer con un array de 0 o 1 elementos.
// Exportada para evals/compare-models.ts (BE-46), mismo criterio que toZoneIntentPlaceholder.
export function toSegments(raw: SegmentLlmOutput, originalText: string): string[] {
  const segments = raw.segments.map(s => s.trim()).filter(s => s.length > 0);
  return segments.length >= 2 ? segments : [originalText];
}

// Agente 0: divide un mensaje en N pedidos de búsqueda independientes cuando corresponde.
// Fail-soft en todos los casos (todos los providers fallan, o el resultado trae 0/1 segmentos):
// se degrada a tratar el mensaje completo como una única búsqueda — nunca lanza, nunca bloquea
// POST /api/search.
export async function segmentSearchRequests(
  fallbackProvider: FallbackProvider,
  messageTexto: string,
  tenantId?: string
): Promise<string[]> {
  try {
    const raw = await fallbackProvider.generateStructured({
      op: 'segment',
      promptVersion: SEGMENTER_PROMPT_VERSION,
      system: SYSTEM_INSTRUCTIONS_SEGMENTER,
      user: buildUserPrompt(messageTexto),
      schema: SegmentSchema,
      tenantId,
      tracingInput: messageTexto
    });
    return toSegments(raw, messageTexto);
  } catch (error) {
    if (error instanceof AllProvidersFailedError) {
      logger.warn('[AI] Todas las estrategias de segmentación fallaron; se trata el mensaje como una sola búsqueda.');
      return [messageTexto];
    }
    throw error;
  }
}
