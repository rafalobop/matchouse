import type { ZodType } from 'zod';

// BE-06: interfaz central de la capa de IA — reemplaza al patrón Strategy de dos clases casi
// idénticas (GeminiStrategy/OpenAIStrategy en el ai.ts viejo, 12 métodos duplicados) por UN
// contrato genérico: cada provider sabe convertir un schema Zod al formato que necesita su SDK,
// validar la respuesta contra ese mismo schema, y devolver el resultado ya tipado. Las 4
// operaciones de negocio (operations/*.ts) quedan agnósticas de qué proveedor están usando.
export interface GenerateStructuredParams<T> {
  // Nombre interno de la operación (ej. 'extract-intent') — se usa para el label del timeout
  // ("Gemini generateContent (extract-intent)") y, en el schema de OpenAI, como json_schema.name.
  op: string;
  system: string;
  user: string;
  schema: ZodType<T>;
}

export interface GenerateStructuredResult<T> {
  data: T;
  usage?: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LLMProvider {
  readonly name: string;
  generateStructured<T>(params: GenerateStructuredParams<T>): Promise<GenerateStructuredResult<T>>;
}

// BE-06: la respuesta del proveedor no es JSON válido, o es JSON válido pero no cumple el schema
// (`schema.safeParse` falló) — en ambos casos, la respuesta no sirve y el llamador (FallbackProvider)
// la trata igual que cualquier otro fallo del proveedor: intenta el siguiente. Reemplaza el
// `JSON.parse` sin validar + la coerción silenciosa de normalizeAgent1/Agent2 del ai.ts viejo —
// acá un fallo de forma/tipo es un error explícito y tipado, nunca un valor "comodín" inventado.
export class SchemaValidationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

// Lanzado por FallbackProvider cuando TODOS los providers configurados fallaron (de cualquier
// motivo: timeout, red, cuota, SchemaValidationError). Cada operación de negocio decide qué hacer
// con esto — algunas lanzan un error distinguible (extractFromTextInput), otras degradan en
// silencio a un valor permisivo (extractZoneIntent/segmentSearchRequests/suggestExcelColumnMapping)
// — esa decisión es de negocio, no de esta capa (ver operations/*.ts).
export class AllProvidersFailedError extends Error {
  constructor(public readonly attempts: { providerName: string; error: unknown }[]) {
    super('Todos los providers de IA configurados fallaron.');
    this.name = 'AllProvidersFailedError';
  }
}
