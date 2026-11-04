import { z } from 'zod';

// BE-09: schema único de extracción — reemplaza los dos schemas separados de Agente 1
// (ExtractIntentSchema, eliminado) y Agente 2 (ZoneLlmOutputSchema, eliminado). Antes, Agente 1 y
// Agente 2 extraían campos solapados (operación, dormitorios, características) con DOS enums de
// operación distintos ('venta'/'alquiler' vs 'ALQUILER'/'COMPRA') que `matcher.ts` tenía que
// reconciliar a mano (preferir uno sobre el otro) en cada estrategia de matching — con una sola
// llamada, no hay dos opiniones que reconciliar.
//
// `location_mentions` reemplaza tanto `zones` (Agente 1, que mapeaba barrios a municipios
// HARDCODEADO en el prompt — ver SYSTEM_INSTRUCTIONS_AGENT1 regla 3 del ai.ts viejo, BE-10
// absorbido acá) como `ubicaciones` (Agente 2, texto crudo sin normalizar). El LLM ya NO mapea
// zonas a municipios — extrae únicamente el texto de ubicación tal cual lo escribió el usuario; la
// resolución contra `neighborhoods`/`neighborhood_aliases` ocurre después, en código puro
// (operations/extractSearchIntent.ts#resolveZoneIntent), igual que ya hacía Agente 2 desde KAN-22.
//
// `bedrooms_min` reemplaza `bedrooms` (Agente 1) y `dormitorios_min` (Agente 2) — un solo campo.
// `features` reemplaza `key_features` (Agente 1) y `caracteristicas_claves` (Agente 2) — un solo
// campo (antes `FeaturesMatchingStrategy` UNÍA ambos arrays; con una sola extracción ya no hay
// nada que unir).
//
// El enum de `operation` es el de Agente 1 ('venta'/'alquiler'/'desconocido', minúsculas) porque
// es el único que coincide con el valor real persistido en `properties.operation` — el de Agente 2
// ('ALQUILER'/'COMPRA'/'DESCONOCIDO') nunca se persistía en ninguna columna, era una convención
// interna de su propio prompt.
export const SearchIntentSchema = z.object({
  operation: z.enum(['venta', 'alquiler', 'desconocido']),
  property_type: z.enum(['departamento', 'casa', 'terreno', 'local', 'oficina', 'otro']),
  location_mentions: z.array(z.string()),
  max_budget: z.number().nullable(),
  currency: z.enum(['USD', 'ARS', 'desconocido']),
  bedrooms_min: z.number().nullable(),
  features: z.array(z.string()),
  country: z.enum(['si', 'no', 'indiferente'])
});

export type SearchIntent = z.infer<typeof SearchIntentSchema>;
