import { z } from 'zod';

// BE-06: schema único de salida del Agente 1 (extracción de texto libre de formulario). Antes
// existían dos JSON Schemas escritos a mano (uno por SDK, con drift real entre ellos — ver
// AGENT1_GEMINI_RESPONSE_SCHEMA/AGENT1_OPENAI_JSON_SCHEMA en el ai.ts viejo) más una función de
// normalización (normalizeAgent1) que coercía/defaulteaba valores fuera de enum en silencio. Este
// schema reemplaza ambos: se convierte a JSON Schema estándar una sola vez (ver
// providers/jsonSchema.ts) y se usa para los dos proveedores, y la validación estructural
// (schema.safeParse en cada provider) reemplaza la coerción silenciosa — un enum inválido ahora
// dispara SchemaValidationError (fallback al siguiente proveedor) en vez de defaultear a
// 'desconocido'/'otro' sin que nadie se entere.
export const ExtractIntentSchema = z.object({
  operation: z.enum(['venta', 'alquiler', 'desconocido']),
  property_type: z.enum(['departamento', 'casa', 'terreno', 'local', 'oficina', 'otro']),
  zones: z.array(z.string()),
  max_budget: z.number().nullable(),
  currency: z.enum(['USD', 'ARS', 'desconocido']),
  bedrooms: z.number().nullable(),
  key_features: z.array(z.string()),
  country: z.enum(['si', 'no', 'indiferente'])
});

export type ExtractedRealEstateRequest = z.infer<typeof ExtractIntentSchema>;
