import { z, type ZodType } from 'zod';

// BE-06: convierte un schema Zod a JSON Schema estándar (draft-07) una sola vez, reusado tanto
// por Gemini (`responseJsonSchema`, alternativa a su formato propietario `responseSchema` con
// tipos en mayúsculas) como por OpenAI (`response_format.json_schema`, que ya espera este
// formato). Antes existían dos JSON Schemas escritos a mano por operación, con drift real entre
// ellos — ver AGENT1_GEMINI_RESPONSE_SCHEMA vs AGENT1_OPENAI_JSON_SCHEMA en el ai.ts viejo.
//
// Verificado contra el código real instalado antes de escribir esto (no asumido de la
// documentación): `z.toJSONSchema` es nativo de Zod v4 (ya instalado, antes solo como
// dependencia transitiva de `openai`) — no hace falta la librería externa `zod-to-json-schema`
// que proponía el ticket original (relevante solo en la era de Zod v3). Y `@google/genai@2.8.0`
// (el SDK ya instalado) soporta `responseJsonSchema` como alternativa a `responseSchema`, leída
// directamente de sus `.d.ts` reales.
//
// `required` incluye TODAS las keys (incluso las `.nullable()`, que Zod v4 sigue listando como
// required — solo permite `null` como valor) y `additionalProperties: false` sale solo, de forma
// recursiva en objetos anidados — confirmado con una corrida real, no asumido: esto es exactamente
// lo que exige el modo strict de OpenAI y el subconjunto soportado por Gemini.
export function toProviderJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>;
  // `$schema` no está en la lista explícita de keys que Gemini acepta en `responseJsonSchema`
  // (type/format/title/description/enum/items/prefixItems/minItems/maxItems/minimum/maximum/
  // anyOf/oneOf/properties/additionalProperties/required/$id/$defs/$ref/$anchor/propertyOrdering)
  // — se quita para no arriesgar que la rechace.
  delete jsonSchema.$schema;
  return jsonSchema;
}

// OpenAI exige que `json_schema.name` matchee `^[a-zA-Z0-9_-]+$` (sin espacios ni otros
// caracteres) — los nombres de operación (`op`, ej. 'extract-intent') ya cumplen esto, pero se
// sanitiza igual por si alguna vez se pasa algo con otro formato.
export function sanitizeSchemaName(op: string): string {
  return op.replace(/[^a-zA-Z0-9_-]/g, '_');
}
