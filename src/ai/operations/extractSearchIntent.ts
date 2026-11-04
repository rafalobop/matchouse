import { config } from '../../config/env';
import { logger } from '../../services/logger';
import { TimeoutError } from '../../utils/withTimeout';
import { withRetry } from '../../utils/withRetry';
import { resolveMultipleNeighborhoodsByText, ZonesServiceError } from '../../services/zonesService';
import { FallbackProvider } from '../providers/fallbackProvider';
import { AllProvidersFailedError } from '../providers/types';
import { SearchIntentSchema, SearchIntent } from '../schemas/searchIntent.schema';
import { ZoneIntentRequest } from '../schemas/zoneIntent.schema';
import { SYSTEM_INSTRUCTIONS_SEARCH_INTENT } from '../prompts';

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
// agotada, respuesta con schema inválido, etc.), la extracción devolvía en silencio un objeto
// "comodín" (`operation: 'desconocido'`, `property_type: 'otro'`) que el matcher trata como
// "matchea con cualquier cosa" — la búsqueda se publicaba igual, sin que el buscador se enterara de
// que la extracción real había fallado. Este error, distinguible (`instanceof
// AIExtractionFailedError`/`error.name`), reemplaza ese fallback silencioso.
//
// BE-09: antes de este ticket, un fallo total SOLO de la llamada de zona (Agente 2) degradaba en
// silencio a `zone_status: 'INDEFINIDA'` (ver la vieja `extractZoneIntent`) — con una sola llamada
// unificada ya no existe esa distinción: si falla la extracción, falló TODO (operación, zona,
// presupuesto, etc. vienen de la misma respuesta), así que el criterio correcto es el más estricto
// de los dos que existían antes (el de Agente 1): siempre un error explícito, nunca una
// degradación silenciosa parcial.
export class AIExtractionFailedError extends Error {
  constructor(message: string = 'No pudimos interpretar tu búsqueda. Probá reformularla o intentá de nuevo en unos minutos.') {
    super(message);
    this.name = 'AIExtractionFailedError';
  }
}

export interface SearchIntentResult {
  intent: SearchIntent;
  zone: ZoneIntentRequest;
}

function buildUserPrompt(freeText: string): string {
  return `Analiza el texto libre provisto por el usuario en un formulario de búsqueda, estrictamente dentro de las etiquetas <USER_TEXT> y </USER_TEXT>:
<USER_TEXT>
${freeText}
</USER_TEXT>`;
}

// KAN-22 + estados de zona (2026-08-11): resuelve zona_ids contra neighborhoods/
// neighborhood_aliases usando las menciones de ubicación que ya extrajo el LLM (posiblemente
// varias, alternativas OR). Nunca lanza — un fallo de DB acá no debe tirar abajo POST /api/search.
// Reintenta hasta 3 veces (withRetry) ante error real de DB/red antes de degradar a DESCONOCIDA —
// un "ninguna mención matcheó" legítimo (sin error) NO se reintenta, resolveMultipleNeighborhoodsByText
// solo lanza ante fallo real de la query. Movida tal cual desde la vieja extractZoneIntent.ts
// (BE-09) — misma lógica, ahora alimentada por `location_mentions` de la extracción unificada en
// vez de la respuesta separada de Agente 2.
async function resolveZoneIntent(locationMentionsRaw: string[]): Promise<ZoneIntentRequest> {
  const locationMentions = locationMentionsRaw.map(s => s.trim()).filter(s => s.length > 0);
  const textoUbicacionOriginal = locationMentions.join(' | ');

  if (locationMentions.length === 0) {
    return { zone_status: 'INDEFINIDA', zona_ids: [], zona_nombres: [], texto_ubicacion_original: '' };
  }

  try {
    const resolved = await withRetry(() => resolveMultipleNeighborhoodsByText(locationMentions), { attempts: 3 });

    if (resolved.length === 0) {
      logger.warn({ texto: textoUbicacionOriginal }, '[AI] Ubicación mencionada pero no resuelta contra neighborhoods tras reintentos; marcada DESCONOCIDA (bloqueante).');
      return { zone_status: 'DESCONOCIDA', zona_ids: [], zona_nombres: [], texto_ubicacion_original: textoUbicacionOriginal };
    }

    return {
      zone_status: 'DEFINIDA',
      zona_ids: resolved.map(r => r.id),
      zona_nombres: resolved.map(r => r.name),
      texto_ubicacion_original: textoUbicacionOriginal
    };
  } catch (error: unknown) {
    const detail = error instanceof ZonesServiceError ? error.message : error instanceof Error ? error.message : String(error);
    logger.error({ error: detail, texto: textoUbicacionOriginal }, '[AI] Fallo de DB al resolver zona tras reintentos; se usa DESCONOCIDA.');
    return { zone_status: 'DESCONOCIDA', zona_ids: [], zona_nombres: [], texto_ubicacion_original: textoUbicacionOriginal };
  }
}

// BE-09: reemplaza a extractFromTextInput (Agente 1) + extractZoneIntent (Agente 2) — UNA sola
// llamada LLM por segmento en vez de dos en serie. La resolución de zona sigue siendo un paso
// aparte DESPUÉS de la llamada (código puro contra la base, nunca LLM), igual que antes.
export async function extractSearchIntent(
  fallbackProvider: FallbackProvider,
  freeText: string,
  tenantId?: string
): Promise<SearchIntentResult> {
  // KAN-38: mismo guard que tenía extractFromTextInput — kill switch de la extracción de texto
  // libre, se perdió al fusionar Agente 1 + Agente 2 en BE-09 y se restaura acá.
  if (!config.freeTextExtractionEnabled) {
    throw new Error('La extracción de texto libre está deshabilitada (FREE_TEXT_EXTRACTION_ENABLED=false). Ver KAN-36.');
  }

  try {
    const intent = await fallbackProvider.generateStructured({
      op: 'extract-search-intent',
      promptVersion: 'search-intent-v1',
      system: SYSTEM_INSTRUCTIONS_SEARCH_INTENT,
      user: buildUserPrompt(freeText),
      schema: SearchIntentSchema,
      tenantId,
      tracingInput: freeText
    });
    const zone = await resolveZoneIntent(intent.location_mentions);
    return { intent, zone };
  } catch (error) {
    if (error instanceof AllProvidersFailedError) {
      // KAN-70/KAN-339: SIEMPRE se lanza un error distinguible en vez de devolver el objeto
      // "comodín" por defecto en silencio. El motivo del fallo (timeout vs. cualquier otro) solo
      // cambia el mensaje/código de error, nunca si hay que avisar o no.
      const allTimeouts = error.attempts.length > 0 && error.attempts.every(a => a.error instanceof TimeoutError);
      logger.error('[AI] Todas las estrategias de extracción de intención de búsqueda fallaron.');
      throw allTimeouts ? new AITimeoutError() : new AIExtractionFailedError();
    }
    throw error;
  }
}
