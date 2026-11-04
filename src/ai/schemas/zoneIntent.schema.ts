// BE-09: `ZoneLlmOutputSchema` (el schema de la respuesta cruda de Agente 2) se elimina — ya no
// hay una llamada LLM separada para zona, se extrae junto con todo lo demás en
// `SearchIntentSchema` (ver searchIntent.schema.ts). Lo que queda acá es solo el shape YA
// RESUELTO contra `neighborhoods` en código (operations/extractSearchIntent.ts#resolveZoneIntent).

// Estado de resolución de zona de una búsqueda. INDEFINIDA: no se mencionó ninguna ubicación (no
// filtra por zona). DEFINIDA: se resolvió contra neighborhoods/neighborhood_aliases (1+ zonas,
// match en OR). DESCONOCIDA: se mencionó una ubicación pero no se pudo resolver tras reintentos —
// filtro duro (bloquea matches) hasta que se cure (self-healing, ver blindMatching.ts).
export type ZoneStatus = 'INDEFINIDA' | 'DEFINIDA' | 'DESCONOCIDA';

// BE-09: antes tenía además `dormitorios_min`/`caracteristicas_claves`/`operacion` — eran la
// copia de Agente 2 de campos que Agente 1 YA extraía por su cuenta. Con una sola extracción
// (`SearchIntent`), esos campos viven ahí una sola vez — cargarlos también acá era pura
// redundancia (confirmado además por `blindMatching.ts#reconstructZoneIntentFromRow`: para
// búsquedas reconstruidas desde la DB esos 3 campos SIEMPRE eran null/[]/DESCONOCIDO, nunca se
// persistieron). `matcher.ts` ya no los lee de acá (ver OperationMatchingStrategy/
// BedroomsMatchingStrategy/FeaturesMatchingStrategy, simplificadas en este mismo ticket).
export interface ZoneIntentRequest {
  zone_status: ZoneStatus;
  // UUIDs de `neighborhoods.id` resueltos. Puede tener más de uno (zonas alternativas OR, ej.
  // "villa lujan o tafi viejo"). Vacío si zone_status no es 'DEFINIDA'.
  zona_ids: string[];
  // Nombres legibles de `neighborhoods.name`, mismo orden/cardinalidad que zona_ids (KAN-92) —
  // nunca mostrarle el UUID crudo al usuario.
  zona_nombres: string[];
  // Texto crudo de ubicación tal cual lo extrajo el LLM. Si el mensaje mencionó varias
  // ubicaciones, vienen unidas con ' | ' — se persiste así en active_searches.zone_text_original
  // para poder reintentar la resolución más tarde sin volver a invocar al LLM.
  texto_ubicacion_original: string;
}
