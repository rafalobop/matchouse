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
// BE-12 (EP-03): rangos plausibles de salida. Antes del cambio, `max_budget`/`bedrooms_min` eran
// `z.number().nullable()` sin signo ni tope — un valor alucinado (negativo, cero, o
// absurdamente grande, ej. un typo de unidades o un intento de manipular `matcher.ts`, que hace
// `request.max_budget * 1.05` sin re-validar) pasaba el schema igual que un valor real. Y
// `location_mentions`/`features` no tenían tope de cantidad ni de longitud por elemento — una
// respuesta patológica (bucle del modelo, o un intento deliberado de inflar el JSON persistido en
// `active_searches.criteria`) también pasaba sin que nada lo frenara. Los topes de abajo no son
// arbitrarios: cotas generosas frente al dominio real (mercado inmobiliario de Tucumán, ver
// `evals/search-intent.jsonl` — el `max_budget` más alto del dataset es 400.000) para no rechazar
// ningún caso legítimo, pero sí capaces de rechazar un valor que ya no tiene relación posible con
// un presupuesto o una cantidad de dormitorios reales.
export const SearchIntentSchema = z.object({
  operation: z.enum(['venta', 'alquiler', 'desconocido']),
  property_type: z.enum(['departamento', 'casa', 'terreno', 'local', 'oficina', 'otro']),
  // Tope de cantidad (nunca se vieron más de 2-3 ubicaciones alternativas en un pedido real) y de
  // longitud por mención (texto libre de ubicación, no una oración completa).
  location_mentions: z.array(z.string().max(200)).max(20),
  // Positivo (un presupuesto de $0 no es un presupuesto, es "no especificado" -> null) y con un
  // tope que cubre cómodamente tanto USD como ARS con inflación real, sin acercarse a magnitudes
  // sin sentido.
  max_budget: z.number().int().positive().max(1_000_000_000).nullable(),
  currency: z.enum(['USD', 'ARS', 'desconocido']),
  // Ninguna propiedad real tiene más de ~20 dormitorios; 0 es válido ("monoambiente").
  bedrooms_min: z.number().int().min(0).max(20).nullable(),
  features: z.array(z.string().max(60)).max(30),
  country: z.enum(['si', 'no', 'indiferente'])
});

export type SearchIntent = z.infer<typeof SearchIntentSchema>;
