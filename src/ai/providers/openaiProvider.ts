import { OpenAI } from 'openai';
import { config } from '../../config/env';
import { withTimeout } from '../../utils/withTimeout';
import { GenerateStructuredParams, GenerateStructuredResult, LLMProvider, SchemaValidationError } from './types';
import { toProviderJsonSchema, sanitizeSchemaName } from './jsonSchema';

export class OpenAIProvider implements LLMProvider {
  private openai = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;

  // BE-46: mismo criterio que GeminiProvider — modelo configurable, default = el fallback de
  // producción; el enrutamiento real sigue construyendo `new OpenAIProvider()` sin argumentos.
  constructor(private readonly model: string = 'gpt-4o-mini') {}

  get name(): string {
    return `OpenAI (${this.model})`;
  }

  async generateStructured<T>(params: GenerateStructuredParams<T>): Promise<GenerateStructuredResult<T>> {
    if (!this.openai) {
      throw new Error('OpenAI API key no está configurada.');
    }

    const completion = await withTimeout(
      this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: sanitizeSchemaName(params.op),
            strict: true,
            schema: toProviderJsonSchema(params.schema)
          }
        }
      }),
      config.aiRequestTimeoutMs,
      `OpenAI chat.completions.create (${params.op})`
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Respuesta de OpenAI vacía');

    let rawData: unknown;
    try {
      rawData = JSON.parse(content.trim());
    } catch (error) {
      throw new SchemaValidationError(`OpenAI (${params.op}) devolvió JSON inválido: ${(error as Error).message}`, error);
    }

    const parsed = params.schema.safeParse(rawData);
    if (!parsed.success) {
      throw new SchemaValidationError(`OpenAI (${params.op}) devolvió una respuesta que no cumple el schema: ${parsed.error.message}`, parsed.error);
    }

    return {
      data: parsed.data as T,
      usage: { inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0 },
      model: this.model
    };
  }
}
