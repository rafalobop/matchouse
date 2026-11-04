import { z } from 'zod';

// BE-06: schema de la salida CRUDA del Agente 2 (zona), tal como la devuelve el LLM — distinto de
// `ZoneIntentRequest` (ver más abajo), que es el shape YA RESUELTO contra `neighborhoods` en
// código (operations/extractZoneIntent.ts#resolveZoneIntent). KAN-22: el LLM nunca devuelve
// zona_ids — solo extrae menciones de ubicación en texto libre.
export const ZoneLlmOutputSchema = z.object({
  ubicaciones: z.array(z.string()),
  dormitorios_min: z.number().nullable(),
  caracteristicas_claves: z.array(z.string()),
  operacion: z.enum(['ALQUILER', 'COMPRA', 'DESCONOCIDO'])
});

export type ZoneLlmOutput = z.infer<typeof ZoneLlmOutputSchema>;

// Estado de resolución de zona de una búsqueda. INDEFINIDA: no se mencionó ninguna ubicación (no
// filtra por zona). DEFINIDA: se resolvió contra neighborhoods/neighborhood_aliases (1+ zonas,
// match en OR). DESCONOCIDA: se mencionó una ubicación pero no se pudo resolver tras reintentos —
// filtro duro (bloquea matches) hasta que se cure (self-healing, ver blindMatching.ts).
export type ZoneStatus = 'INDEFINIDA' | 'DEFINIDA' | 'DESCONOCIDA';

// No se deriva de un Zod schema (a diferencia de ExtractedRealEstateRequest) porque mezcla datos
// que SÍ vienen del LLM (dormitorios_min, caracteristicas_claves, operacion, texto_ubicacion_original)
// con datos que se resuelven DESPUÉS contra la base (zone_status, zona_ids, zona_nombres) — no hay
// un único "parse" de entrada que produzca este shape completo de una sola vez.
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
  dormitorios_min: number | null;
  caracteristicas_claves: string[];
  operacion: 'ALQUILER' | 'COMPRA' | 'DESCONOCIDO';
}
