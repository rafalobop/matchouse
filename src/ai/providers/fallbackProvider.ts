import type { ZodType } from 'zod';
import { logger } from '../../services/logger';
import { recordLlmGeneration } from '../../services/tracing';
import { persistLlmCall, logFallbackWarning } from '../observability';
import { AllProvidersFailedError, LLMProvider } from './types';

export interface FallbackCallParams<T> {
  op: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  tenantId?: string;
  // Lo que se muestra como "input" en la traza de Langfuse — normalmente el texto crudo del
  // usuario (freeText/messageTexto), NO el `user` ya armado con <USER_TEXT> y demás template. Ver
  // tracing.ts#recordLlmGeneration.
  tracingInput: unknown;
}

// BE-06: reemplaza el loop de fallback que antes vivía duplicado dentro de cada uno de los 4
// métodos de AIExtractorContext (segment/extractIntent/extractZone/excelMapping, ~16 bloques
// casi idénticos de try/catch + recordLlmGeneration + persistLlmCall) por UNA sola
// implementación genérica, parametrizada por operación. Cada operación de negocio
// (operations/*.ts) le pasa su prompt/schema/metadata y recibe el `data` ya validado, o un
// `AllProvidersFailedError` si TODOS los providers fallaron — qué hacer ante eso (lanzar un error
// distinguible, degradar en silencio, etc.) es decisión de cada operación, no de esta clase.
export class FallbackProvider {
  constructor(private readonly providers: LLMProvider[]) {}

  async generateStructured<T>(params: FallbackCallParams<T>): Promise<T> {
    const attempts: { providerName: string; error: unknown }[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const fallbackUsed = i > 0;
      const startTime = new Date();

      try {
        logger.info({ providerName: provider.name, op: params.op }, '[AI] Intentando proveedor');
        const result = await provider.generateStructured({ op: params.op, system: params.system, user: params.user, schema: params.schema });

        recordLlmGeneration({
          name: params.op, model: result.model, promptVersion: params.promptVersion,
          input: params.tracingInput, output: result.data, usage: result.usage, fallbackUsed, schemaValid: true, startTime
        });
        persistLlmCall({
          operation: params.op, model: result.model, promptVersion: params.promptVersion,
          usage: result.usage, startTime, fallbackUsed, schemaValid: true, tenantId: params.tenantId
        });

        return result.data;
      } catch (error) {
        recordLlmGeneration({
          name: params.op, model: provider.name, promptVersion: params.promptVersion,
          input: params.tracingInput, output: null, usage: undefined, fallbackUsed, schemaValid: false, startTime,
          error: error instanceof Error ? error.message : String(error)
        });
        persistLlmCall({
          operation: params.op, model: provider.name, promptVersion: params.promptVersion,
          usage: undefined, startTime, fallbackUsed, schemaValid: false, tenantId: params.tenantId
        });
        logFallbackWarning(provider.name, error);
        attempts.push({ providerName: provider.name, error });
      }
    }

    throw new AllProvidersFailedError(attempts);
  }
}
