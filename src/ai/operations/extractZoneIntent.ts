import { logger } from '../../services/logger';
import { withRetry } from '../../utils/withRetry';
import { resolveMultipleNeighborhoodsByText, ZonesServiceError } from '../../services/zonesService';
import { FallbackProvider } from '../providers/fallbackProvider';
import { AllProvidersFailedError } from '../providers/types';
import { ZoneLlmOutputSchema, ZoneLlmOutput, ZoneIntentRequest } from '../schemas/zoneIntent.schema';
import { SYSTEM_INSTRUCTIONS_AGENT2 } from '../prompts';

function buildUserPrompt(messageTexto: string, operacion?: string): string {
  return operacion && operacion !== 'desconocido'
    ? `Operación identificada por el Agente 1: ${operacion}\n\nClasifica la zona e intención del texto provisto estrictamente dentro de las etiquetas <USER_TEXT> y </USER_TEXT>:\n<USER_TEXT>\n${messageTexto}\n</USER_TEXT>`
    : `Clasifica la zona e intención del texto provisto estrictamente dentro de las etiquetas <USER_TEXT> y </USER_TEXT>:\n<USER_TEXT>\n${messageTexto}\n</USER_TEXT>`;
}

// KAN-22: zona_ids ya NO sale del LLM — el schema (ZoneLlmOutputSchema) ya garantiza la forma y
// los enums; lo que queda es la decisión de NEGOCIO de rellenar "operacion" con la pista del
// Agente 1 cuando el Agente 2 devolvió DESCONOCIDO, y limpiar las menciones de ubicación antes de
// unirlas en una sola columna DB (zone_text_original). Esto es cross-referencing de otro
// parámetro (operacionOriginal) y limpieza de ruido del LLM, no validación estructural — por eso
// vive acá, no en el schema (ver conversación de diseño de BE-06).
// Exportada para evals/compare-models.ts (BE-46), que necesita aplicar la misma limpieza de
// negocio sobre la respuesta cruda de un único provider aislado, sin pasar por el fallback ni por
// resolveZoneIntent (ninguna métrica de esa comparativa depende de zona_ids/zona_nombres).
export function toZoneIntentPlaceholder(parsed: ZoneLlmOutput, operacionOriginal?: string): ZoneIntentRequest {
  let operacion = parsed.operacion;
  if (operacion === 'DESCONOCIDO' && operacionOriginal && operacionOriginal !== 'desconocido') {
    operacion = operacionOriginal === 'venta' ? 'COMPRA' : 'ALQUILER';
  }

  const ubicaciones = parsed.ubicaciones.map(u => u.trim()).filter(u => u.length > 0);

  return {
    zone_status: 'INDEFINIDA', // placeholder — resolveZoneIntent lo sobrescribe con el resultado real
    zona_ids: [],
    zona_nombres: [],
    texto_ubicacion_original: ubicaciones.join(' | '),
    dormitorios_min: parsed.dormitorios_min,
    caracteristicas_claves: parsed.caracteristicas_claves,
    operacion
  };
}

// KAN-22 + estados de zona (2026-08-11): resuelve zona_ids contra neighborhoods/
// neighborhood_aliases usando las menciones de ubicación que ya extrajo el LLM (posiblemente
// varias, alternativas OR). Nunca lanza — un fallo de DB acá no debe tirar abajo POST /api/search.
// Reintenta hasta 3 veces (withRetry) ante error real de DB/red antes de degradar a DESCONOCIDA —
// un "ninguna mención matcheó" legítimo (sin error) NO se reintenta, resolveMultipleNeighborhoodsByText
// solo lanza ante fallo real de la query.
async function resolveZoneIntent(zoneIntent: ZoneIntentRequest): Promise<ZoneIntentRequest> {
  const locationMentions = zoneIntent.texto_ubicacion_original
    .split(' | ')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (locationMentions.length === 0) {
    return { ...zoneIntent, zone_status: 'INDEFINIDA', zona_ids: [], zona_nombres: [] };
  }

  try {
    const resolved = await withRetry(() => resolveMultipleNeighborhoodsByText(locationMentions), { attempts: 3 });

    if (resolved.length === 0) {
      logger.warn({ texto: zoneIntent.texto_ubicacion_original }, '[AI] Ubicación mencionada pero no resuelta contra neighborhoods tras reintentos; marcada DESCONOCIDA (bloqueante).');
      return { ...zoneIntent, zone_status: 'DESCONOCIDA', zona_ids: [], zona_nombres: [] };
    }

    return {
      ...zoneIntent,
      zone_status: 'DEFINIDA',
      zona_ids: resolved.map(r => r.id),
      zona_nombres: resolved.map(r => r.name)
    };
  } catch (error: unknown) {
    const detail = error instanceof ZonesServiceError ? error.message : error instanceof Error ? error.message : String(error);
    logger.error({ error: detail, texto: zoneIntent.texto_ubicacion_original }, '[AI] Fallo de DB al resolver zona tras reintentos; se usa DESCONOCIDA.');
    return { ...zoneIntent, zone_status: 'DESCONOCIDA', zona_ids: [], zona_nombres: [] };
  }
}

export async function extractZoneIntent(
  fallbackProvider: FallbackProvider,
  messageTexto: string,
  operacion?: 'venta' | 'alquiler' | 'desconocido',
  tenantId?: string
): Promise<ZoneIntentRequest> {
  try {
    const raw = await fallbackProvider.generateStructured({
      op: 'extract-zone',
      promptVersion: 'agent2-v1',
      system: SYSTEM_INSTRUCTIONS_AGENT2,
      user: buildUserPrompt(messageTexto, operacion),
      schema: ZoneLlmOutputSchema,
      tenantId,
      tracingInput: messageTexto
    });
    const placeholder = toZoneIntentPlaceholder(raw, operacion);
    return await resolveZoneIntent(placeholder);
  } catch (error) {
    if (error instanceof AllProvidersFailedError) {
      // Fallo total del LLM (todos los providers) — no hay evidencia de que el usuario mencionara
      // una zona real, solo que el LLM no respondió, así que se degrada a INDEFINIDA (no
      // bloqueante) y no DESCONOCIDA (que sí bloquea matches).
      //
      // KAN-339 (revisión de consistencia, sin cambio de comportamiento): a primera vista esto
      // parece el mismo problema que extractFromTextInput (Agente 1) tenía — un fallo total de IA
      // degradando en silencio a un valor permisivo. Se decidió NO alinearlo a lanzar un error
      // distinguible como el Agente 1, por una diferencia real de riesgo entre ambos: el Agente 1
      // arriesgaba publicar una búsqueda con operation/property_type comodín — un estado que NUNCA
      // es válido como intención real del usuario. El Agente 2 (zona), en cambio, degrada al mismo
      // estado (INDEFINIDA) que ya usa legítimamente cualquier búsqueda real donde el usuario
      // simplemente no mencionó ninguna zona — no hay forma de distinguir "la IA falló" de "no
      // había zona que extraer" sin la IA misma, y tratar ambos casos como bloqueantes rechazaría
      // de forma agresiva búsquedas válidas sin zona.
      logger.error('[AI] Todas las estrategias de zona fallaron.');
      return {
        zone_status: 'INDEFINIDA',
        zona_ids: [],
        zona_nombres: [],
        texto_ubicacion_original: '',
        dormitorios_min: null,
        caracteristicas_claves: [],
        operacion: 'DESCONOCIDO'
      };
    }
    throw error;
  }
}
