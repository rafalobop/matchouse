import { OpenAI } from 'openai';
import { config } from '../config/env';
import { withTimeout } from '../utils/withTimeout';

// BE-19 (EP-07): servicio de embeddings — hoy solo lo consume el fallback semántico de zonas
// (zonesService.ts#resolveNeighborhoodBySemanticSearch, BE-20) y su script de backfill
// (scripts/backfill-neighborhood-embeddings.ts), pero vive separado de zonesService para no
// acoplar "cómo se genera un embedding" a "cómo se usa para resolver una zona" — un futuro
// consumidor (ej. re-rank de matching general) reutilizaría este módulo sin tocar zonas.
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

export class EmbeddingServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EmbeddingServiceError';
  }
}

// Mismo patrón de seam de inyección que `llmCallsClient`/`__setLlmCallsClientForTests`
// (observability.ts) y `resendClient` (notifier-email.ts) — variable de módulo mutable, default
// el cliente real, setter exportado solo para tests. Sin esto, cualquier test que ejercite el
// código real (no solo mockee la función exportada) terminaría llamando a la API real de OpenAI.
let openaiClient: OpenAI | null = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;

export function __setOpenAIEmbeddingsClientForTests(client: OpenAI | null): void {
  openaiClient = client;
}

/**
 * Genera un embedding por cada texto de `texts`, en el mismo orden (la API de OpenAI garantiza
 * que `response.data[i].index === i`, pero no reordenamos por las dudas — ver nota abajo).
 * Batcheado en una sola llamada HTTP (la API de embeddings de OpenAI acepta `input` como array) —
 * a diferencia de Gemini (cap de 20 req/día/modelo en free tier, BE-46), OpenAI no tiene ese límite
 * diario, pero batchear 182 zonas en 1-2 llamadas en vez de 182 sigue siendo la opción correcta
 * por costo/latencia de red, no por evitar una cuota.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!openaiClient) {
    throw new EmbeddingServiceError('OpenAI API key no está configurada (OPENAI_API_KEY).');
  }

  let response;
  try {
    response = await withTimeout(
      openaiClient.embeddings.create({ model: EMBEDDING_MODEL, input: texts }),
      config.aiRequestTimeoutMs,
      `OpenAI embeddings.create (${texts.length} textos)`
    );
  } catch (error) {
    throw new EmbeddingServiceError(`Fallo al generar embeddings: ${error instanceof Error ? error.message : String(error)}`, error);
  }

  // Defensivo, no asumido: la documentación de OpenAI garantiza el mismo orden que `input`, pero
  // cada elemento de `response.data` trae su propio `index` — reordenar explícitamente por ese
  // campo es gratis y evita un bug silencioso de desalineación si esa garantía cambiara.
  const byIndex = new Map(response.data.map((d) => [d.index, d.embedding]));
  return texts.map((_, i) => {
    const embedding = byIndex.get(i);
    if (!embedding) {
      throw new EmbeddingServiceError(`OpenAI no devolvió un embedding para el índice ${i} de ${texts.length}.`);
    }
    return embedding;
  });
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await generateEmbeddings([text]);
  return embedding;
}

/**
 * pgvector espera el literal `"[0.1,0.2,...]"` como string al escribir/leer una columna `vector`
 * desde el cliente de Supabase (no tiene un tipo JS nativo) — centralizado acá porque tanto el
 * backfill (escribe) como la búsqueda semántica (pasa `query_embedding` al RPC) lo necesitan.
 */
export function toPgVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

function normalizeNeighborhoodName(name: string): string {
  return name.toLowerCase().replace(/_/g, ' ').trim();
}

/**
 * Texto que se embebe por zona: el nombre normalizado (mismo criterio de KAN-337,
 * "ZONA_CENTRO" -> "zona centro") más sus alias curados, deduplicados. Un embedding por zona
 * (nunca uno por alias) — más simple de mantener y de buscar, y 1-2 alias cortos no aportan
 * suficiente señal semántica propia como para justificar embeddings separados.
 */
export function buildNeighborhoodEmbeddingText(name: string, aliases: string[]): string {
  const parts = [normalizeNeighborhoodName(name), ...aliases.map((a) => a.toLowerCase().trim())];
  const unique = Array.from(new Set(parts.filter((p) => p.length > 0)));
  return unique.join(', ');
}
