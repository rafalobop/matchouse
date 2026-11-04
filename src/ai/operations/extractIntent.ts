import { config } from '../../config/env';
import { logger } from '../../services/logger';
import { TimeoutError } from '../../utils/withTimeout';
import { FallbackProvider } from '../providers/fallbackProvider';
import { AllProvidersFailedError } from '../providers/types';
import { ExtractIntentSchema, ExtractedRealEstateRequest } from '../schemas/extractIntent.schema';
import { SYSTEM_INSTRUCTIONS_AGENT1_TEXT_INPUT } from '../prompts';

// KAN-70: error específico para cuando TODAS las estrategias de IA configuradas agotaron su
// timeout en el camino síncrono de un request HTTP (POST /api/search, ver src/index.ts). A
// diferencia de un error genérico, el frontend puede distinguir este caso (`instanceof
// AITimeoutError` / `error.name === 'AITimeoutError'`) para mostrar un mensaje específico
// ("el servicio de IA tardó demasiado") en vez del error interno genérico de un 500.
export class AITimeoutError extends Error {
  constructor(message: string = 'El servicio de IA no respondió a tiempo. Intentá de nuevo en unos segundos.') {
    super(message);
    this.name = 'AITimeoutError';
  }
}

// KAN-339: antes, si TODAS las estrategias de IA fallaban por un motivo que no era timeout (cuota
// agotada, respuesta con schema inválido, etc.), `extractFromTextInput` devolvía en silencio un
// objeto "comodín" (`operation: 'desconocido'`, `property_type: 'otro'`) que el matcher trata como
// "matchea con cualquier cosa" — la búsqueda se publicaba igual, sin que el buscador se enterara de
// que la extracción real había fallado. Este error, distinguible (`instanceof
// AIExtractionFailedError`/`error.name`), reemplaza ese fallback silencioso.
export class AIExtractionFailedError extends Error {
  constructor(message: string = 'No pudimos interpretar tu búsqueda. Probá reformularla o intentá de nuevo en unos minutos.') {
    super(message);
    this.name = 'AIExtractionFailedError';
  }
}

function buildUserPrompt(freeText: string): string {
  return `Analiza el texto libre provisto por el usuario en un formulario de búsqueda, estrictamente dentro de las etiquetas <USER_TEXT> y </USER_TEXT>:
<USER_TEXT>
${freeText}
</USER_TEXT>`;
}

// KAN-36: extractor de texto libre de formulario (matching ciego), Agente 1. `fallbackProvider`
// se inyecta desde src/ai/index.ts (el único lugar que decide el orden real Gemini->OpenAI) para
// que esta función no construya providers por su cuenta — facilita testear con un fake.
export async function extractFromTextInput(
  fallbackProvider: FallbackProvider,
  freeText: string,
  tenantId?: string
): Promise<ExtractedRealEstateRequest> {
  if (!config.freeTextExtractionEnabled) {
    throw new Error('La extracción de texto libre está deshabilitada (FREE_TEXT_EXTRACTION_ENABLED=false). Ver KAN-36.');
  }

  try {
    return await fallbackProvider.generateStructured({
      op: 'extract-intent',
      promptVersion: 'agent1-text-input-v1',
      system: SYSTEM_INSTRUCTIONS_AGENT1_TEXT_INPUT,
      user: buildUserPrompt(freeText),
      schema: ExtractIntentSchema,
      tenantId,
      tracingInput: freeText
    });
  } catch (error) {
    if (error instanceof AllProvidersFailedError) {
      // KAN-70/KAN-339: SIEMPRE se lanza un error distinguible en vez de devolver el objeto
      // "comodín" por defecto en silencio. El motivo del fallo (timeout vs. cualquier otro) solo
      // cambia el mensaje/código de error, nunca si hay que avisar o no.
      const allTimeouts = error.attempts.length > 0 && error.attempts.every(a => a.error instanceof TimeoutError);
      logger.error('[AI] Todas las estrategias de extracción de texto libre fallaron.');
      throw allTimeouts ? new AITimeoutError() : new AIExtractionFailedError();
    }
    throw error;
  }
}
