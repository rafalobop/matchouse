import { GoogleGenAI } from '@google/genai';
import { config } from '../../config/env';
import { withTimeout } from '../../utils/withTimeout';
import { GenerateStructuredParams, GenerateStructuredResult, LLMProvider, SchemaValidationError } from './types';
import { toProviderJsonSchema } from './jsonSchema';

export class GeminiProvider implements LLMProvider {
  private ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  // BE-46: modelo configurable (default = el primario de producción) para poder instanciar
  // variantes puntuales en evals/compare-models.ts sin tocar el enrutamiento real (que sigue
  // construyendo `new GeminiProvider()` sin argumentos).
  constructor(private readonly model: string = 'gemini-2.5-flash-lite') {}

  get name(): string {
    return `Google Gemini (${this.model})`;
  }

  async generateStructured<T>(params: GenerateStructuredParams<T>): Promise<GenerateStructuredResult<T>> {
    const response = await withTimeout(
      this.ai.models.generateContent({
        model: this.model,
        contents: params.user,
        config: {
          systemInstruction: params.system,
          responseMimeType: 'application/json',
          responseJsonSchema: toProviderJsonSchema(params.schema)
        }
      }),
      config.aiRequestTimeoutMs,
      `Gemini generateContent (${params.op})`
    );

    const responseText = response.text;
    if (!responseText) throw new Error('Respuesta de Gemini vacía');

    let rawData: unknown;
    try {
      rawData = JSON.parse(responseText.trim());
    } catch (error) {
      throw new SchemaValidationError(`Gemini (${params.op}) devolvió JSON inválido: ${(error as Error).message}`, error);
    }

    const parsed = params.schema.safeParse(rawData);
    if (!parsed.success) {
      throw new SchemaValidationError(`Gemini (${params.op}) devolvió una respuesta que no cumple el schema: ${parsed.error.message}`, parsed.error);
    }

    return {
      data: parsed.data as T,
      usage: { inputTokens: response.usageMetadata?.promptTokenCount ?? 0, outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0 },
      model: this.model
    };
  }
}
