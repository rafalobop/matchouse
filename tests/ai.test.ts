import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import {
  extractSearchIntent,
  segmentSearchRequests,
  suggestExcelColumnMapping,
  GeminiProvider,
  OpenAIProvider,
  FallbackProvider,
  AllProvidersFailedError,
  SchemaValidationError,
  SearchIntentSchema,
  AITimeoutError,
  AIExtractionFailedError,
  __setLlmCallsClientForTests,
  LLMProvider,
  GenerateStructuredResult
} from '../src/ai';
import { TimeoutError } from '../src/utils/withTimeout';
import { config, validateConfig } from '../src/config/env';
import { createFakeSupabaseClient, chainableResult } from './helpers/fakeSupabaseClient';

// BE-06 (fix heredado de BE-04): FallbackProvider persiste una fila en llm_calls por cada llamada
// real — sin este fake, correr este archivo (que SÍ ejercita el pipeline real de providers/fallback
// para varios de estos tests, no solo normalización pura) insertaría filas reales en la tabla de
// producción. Ver observability.ts.
__setLlmCallsClientForTests(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));

test('AI Service - Debería exportar las funciones clave (BE-09: extractSearchIntent fusiona Agente 1 + Agente 2)', () => {
  assert.strictEqual(typeof extractSearchIntent, 'function', 'extractSearchIntent debe ser una función.');
  assert.strictEqual(typeof segmentSearchRequests, 'function', 'segmentSearchRequests debe ser una función.');
  assert.strictEqual(typeof suggestExcelColumnMapping, 'function', 'suggestExcelColumnMapping debe ser una función.');
});

test('AI Service - FREE_TEXT_EXTRACTION_ENABLED (KAN-38) está habilitado por default y respeta override explícito', () => {
  const originalValue = process.env.FREE_TEXT_EXTRACTION_ENABLED;
  try {
    delete process.env.FREE_TEXT_EXTRACTION_ENABLED;
    const defaultConfig = validateConfig();
    assert.strictEqual(defaultConfig.freeTextExtractionEnabled, true, 'Sin la variable definida, la extracción de texto libre debe estar habilitada por default (KAN-38).');

    process.env.FREE_TEXT_EXTRACTION_ENABLED = 'true';
    const enabledConfig = validateConfig();
    assert.strictEqual(enabledConfig.freeTextExtractionEnabled, true, 'Con FREE_TEXT_EXTRACTION_ENABLED=true explícito, debe habilitarse.');

    process.env.FREE_TEXT_EXTRACTION_ENABLED = 'false';
    const explicitDisabledConfig = validateConfig();
    assert.strictEqual(explicitDisabledConfig.freeTextExtractionEnabled, false, 'Con FREE_TEXT_EXTRACTION_ENABLED=false explícito, debe seguir deshabilitada.');
  } finally {
    if (originalValue === undefined) {
      delete process.env.FREE_TEXT_EXTRACTION_ENABLED;
    } else {
      process.env.FREE_TEXT_EXTRACTION_ENABLED = originalValue;
    }
  }
});

test('AI Service - extractSearchIntent (KAN-36/BE-09) rechaza sin llamar a ningún proveedor de IA cuando el flag está deshabilitado', async () => {
  const original = config.freeTextExtractionEnabled;
  try {
    config.freeTextExtractionEnabled = false;
    await assert.rejects(
      () => extractSearchIntent('busco depto 2 dorm en yerba buena hasta 80000 usd'),
      /FREE_TEXT_EXTRACTION_ENABLED/,
      'Con el flag deshabilitado, extractSearchIntent debe rechazar de inmediato mencionando el flag.'
    );
  } finally {
    config.freeTextExtractionEnabled = original;
  }
});

test('AI Service - SearchIntentSchema (BE-09) acepta/rechaza variaciones del contrato unificado', () => {
  const casoCompleto = {
    operation: 'venta', property_type: 'departamento', location_mentions: ['Yerba Buena'], max_budget: 80000,
    currency: 'USD', bedrooms_min: 2, features: ['cochera', 'pileta'], country: 'no'
  };
  assert.strictEqual(SearchIntentSchema.safeParse(casoCompleto).success, true, 'Un caso bien formado debe pasar el schema.');

  // BE-06/BE-09: un enum en mayúsculas o inventado es un fallo de schema explícito — decisión de
  // diseño documentada: la validación de schema se encarga de la FORMA, las decisiones de negocio
  // (qué hacer ante un fallo total de todos los proveedores) siguen en las operaciones (ver
  // AIExtractionFailedError).
  const casoMayusculas = { ...casoCompleto, operation: 'VENTA' };
  assert.strictEqual(SearchIntentSchema.safeParse(casoMayusculas).success, false, 'Un enum en mayúsculas debe fallar el schema (los providers ya fuerzan minúsculas vía structured output).');

  const casoEnumInventado = { ...casoCompleto, property_type: 'mansion' };
  assert.strictEqual(SearchIntentSchema.safeParse(casoEnumInventado).success, false, 'Un enum fuera de la lista debe fallar el schema.');

  const casoSinCampos = {};
  assert.strictEqual(SearchIntentSchema.safeParse(casoSinCampos).success, false, 'Campos faltantes deben fallar el schema (son todos requeridos, incluso los nullable).');

  const casoNulls = { ...casoCompleto, max_budget: null, bedrooms_min: null };
  assert.strictEqual(SearchIntentSchema.safeParse(casoNulls).success, true, 'max_budget/bedrooms_min nullable deben aceptar null.');
});

// --- KAN-70: timeout en las llamadas reales a los SDKs ---
// No se mockea el SDK con una librería externa (el proyecto no usa jest/sinon) — en cambio, se
// sobreescribe el método real del cliente SDK ya instanciado (this.ai.models.generateContent /
// this.openai.chat.completions.create) para que devuelva una promesa que nunca resuelve,
// ejercitando el wrapping real de withTimeout dentro de GeminiProvider/OpenAIProvider.

test('AI Providers (KAN-70) - GeminiProvider.generateStructured usa withTimeout (rechaza con TimeoutError si el SDK cuelga)', async () => {
  const originalTimeout = config.aiRequestTimeoutMs;
  config.aiRequestTimeoutMs = 30;
  try {
    const provider = new GeminiProvider();
    (provider as any).ai.models.generateContent = () => new Promise(() => {});

    await assert.rejects(
      () => provider.generateStructured({ op: 'extract-search-intent', system: 'instrucción', user: 'texto', schema: SearchIntentSchema }),
      (error: any) => {
        assert.ok(error instanceof TimeoutError, 'El error debe ser una instancia de TimeoutError.');
        assert.match(error.message, /Gemini generateContent/, 'El mensaje debe identificar la llamada de Gemini.');
        return true;
      }
    );
  } finally {
    config.aiRequestTimeoutMs = originalTimeout;
  }
});

test(
  'AI Providers (KAN-70) - OpenAIProvider.generateStructured usa withTimeout (rechaza con TimeoutError si el SDK cuelga)',
  { skip: !config.openaiApiKey ? 'OPENAI_API_KEY no configurada en este entorno' : false },
  async () => {
    const originalTimeout = config.aiRequestTimeoutMs;
    config.aiRequestTimeoutMs = 30;
    try {
      const provider = new OpenAIProvider();
      (provider as any).openai.chat.completions.create = () => new Promise(() => {});

      await assert.rejects(
        () => provider.generateStructured({ op: 'extract-search-intent', system: 'instrucción', user: 'texto', schema: SearchIntentSchema }),
        (error: any) => {
          assert.ok(error instanceof TimeoutError, 'El error debe ser una instancia de TimeoutError.');
          assert.match(error.message, /OpenAI chat\.completions\.create/, 'El mensaje debe identificar la llamada de OpenAI.');
          return true;
        }
      );
    } finally {
      config.aiRequestTimeoutMs = originalTimeout;
    }
  }
);

// --- Fakes de LLMProvider para probar FallbackProvider y las operaciones sin red real ---
// BE-06: reemplaza el patrón anterior de monkey-patchear GeminiStrategy.prototype.X — con
// inyección de dependencias real (FallbackProvider recibe un array de LLMProvider en su
// constructor), un test puede construir un fake sin tocar ninguna clase global.

function makeFakeProvider(name: string, impl: (op: string, schema: z.ZodType<any>) => Promise<GenerateStructuredResult<any>>): LLMProvider {
  return {
    name,
    generateStructured: (params) => impl(params.op, params.schema)
  };
}

function alwaysFails(name: string, error: unknown = new Error(`Falla simulada de ${name}`)): LLMProvider {
  return makeFakeProvider(name, async () => { throw error; });
}

function alwaysSucceeds<T>(name: string, data: T, model = name): LLMProvider {
  return makeFakeProvider(name, async () => ({ data, usage: { inputTokens: 10, outputTokens: 5 }, model }));
}

test('FallbackProvider - devuelve el resultado del primer provider exitoso, sin intentar el siguiente', async () => {
  const fallback = new FallbackProvider([
    alwaysSucceeds('A', { ok: true }),
    alwaysFails('B')
  ]);
  const result = await fallback.generateStructured({
    op: 'test-op', promptVersion: 'v1', system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), tracingInput: 'input'
  });
  assert.deepStrictEqual(result, { ok: true });
});

test('FallbackProvider - cae al siguiente provider cuando el primero falla', async () => {
  const fallback = new FallbackProvider([
    alwaysFails('A'),
    alwaysSucceeds('B', { ok: true })
  ]);
  const result = await fallback.generateStructured({
    op: 'test-op', promptVersion: 'v1', system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), tracingInput: 'input'
  });
  assert.deepStrictEqual(result, { ok: true });
});

test('FallbackProvider - un JSON que no cumple el schema cuenta como fallo de ESE provider (cae al siguiente)', async () => {
  const schema = z.object({ ok: z.boolean() });
  const fallback = new FallbackProvider([
    makeFakeProvider('A', async () => { throw new SchemaValidationError('forma inválida'); }),
    alwaysSucceeds('B', { ok: true })
  ]);
  const result = await fallback.generateStructured({ op: 'test-op', promptVersion: 'v1', system: 's', user: 'u', schema, tracingInput: 'input' });
  assert.deepStrictEqual(result, { ok: true });
});

test('FallbackProvider - lanza AllProvidersFailedError con los intentos de cada provider cuando todos fallan', async () => {
  const errorA = new Error('falla A');
  const errorB = new TimeoutError('falla B');
  const fallback = new FallbackProvider([alwaysFails('A', errorA), alwaysFails('B', errorB)]);

  await assert.rejects(
    () => fallback.generateStructured({ op: 'test-op', promptVersion: 'v1', system: 's', user: 'u', schema: z.object({ ok: z.boolean() }), tracingInput: 'input' }),
    (error: any) => {
      assert.ok(error instanceof AllProvidersFailedError);
      assert.strictEqual(error.attempts.length, 2);
      assert.strictEqual(error.attempts[0].providerName, 'A');
      assert.strictEqual(error.attempts[0].error, errorA);
      assert.strictEqual(error.attempts[1].providerName, 'B');
      assert.strictEqual(error.attempts[1].error, errorB);
      return true;
    }
  );
});

// --- KAN-70/KAN-339: extractSearchIntent y la distinción AITimeoutError vs AIExtractionFailedError ---
// BE-09: antes estos tests ejercitaban por separado extractFromTextInput (Agente 1) y
// extractZoneIntent (Agente 2) — el fallo total de Agente 2 degradaba en silencio a
// zone_status: 'INDEFINIDA'. Con una sola llamada LLM, un fallo total es un fallo de TODO
// (operación + zona + presupuesto vienen de la misma respuesta), así que el criterio correcto es
// siempre el más estricto: nunca degradar en silencio, siempre lanzar AITimeoutError o
// AIExtractionFailedError. Se llama a la implementación interna (no al wrapper del barrel) para
// poder inyectar un FallbackProvider de prueba.

import { extractSearchIntent as extractSearchIntentOp } from '../src/ai/operations/extractSearchIntent';
import { segmentSearchRequests as segmentSearchRequestsOp } from '../src/ai/operations/segment';
import { suggestExcelColumnMapping as suggestExcelColumnMappingOp } from '../src/ai/operations/excelMapping';

test('extractSearchIntent (KAN-70) lanza AITimeoutError cuando TODOS los providers agotan el timeout', async () => {
  const originalFlag = config.freeTextExtractionEnabled;
  config.freeTextExtractionEnabled = true;
  try {
    const fallback = new FallbackProvider([
      alwaysFails('Gemini', new TimeoutError('Timeout simulado de Gemini (KAN-70)')),
      alwaysFails('OpenAI', new TimeoutError('Timeout simulado de OpenAI (KAN-70)'))
    ]);
    await assert.rejects(
      () => extractSearchIntentOp(fallback, 'busco depto 2 dorm en yerba buena hasta 80000 usd'),
      (error: any) => {
        assert.ok(error instanceof AITimeoutError, 'Debe lanzar AITimeoutError cuando todos los providers agotan el timeout, en vez de devolver el fallback silencioso.');
        return true;
      }
    );
  } finally {
    config.freeTextExtractionEnabled = originalFlag;
  }
});

test('extractSearchIntent (KAN-70/KAN-339) lanza AIExtractionFailedError (no AITimeoutError) si al menos un provider falló por un motivo distinto a timeout', async () => {
  const originalFlag = config.freeTextExtractionEnabled;
  config.freeTextExtractionEnabled = true;
  try {
    const fallback = new FallbackProvider([
      alwaysFails('Gemini', new TimeoutError('Timeout simulado de Gemini (KAN-70)')),
      alwaysFails('OpenAI', new Error('Cuota excedida (no es timeout)'))
    ]);
    await assert.rejects(
      () => extractSearchIntentOp(fallback, 'busco depto 2 dorm en yerba buena hasta 80000 usd'),
      (error: any) => {
        assert.ok(error instanceof AIExtractionFailedError, 'KAN-339: un fallo mixto (un timeout + un fallo real) debe lanzar AIExtractionFailedError, no degradar en silencio a criterios comodín.');
        return true;
      }
    );
  } finally {
    config.freeTextExtractionEnabled = originalFlag;
  }
});

test('extractSearchIntent (KAN-339) lanza AIExtractionFailedError cuando TODOS los providers fallan por un motivo que no es timeout', async () => {
  const originalFlag = config.freeTextExtractionEnabled;
  config.freeTextExtractionEnabled = true;
  try {
    const fallback = new FallbackProvider([
      alwaysFails('Gemini', new Error('Cuota excedida (no es timeout)')),
      alwaysFails('OpenAI', new Error('Respuesta con schema inválido (no es timeout)'))
    ]);
    await assert.rejects(
      () => extractSearchIntentOp(fallback, 'busco depto 2 dorm en yerba buena hasta 80000 usd'),
      (error: any) => {
        assert.ok(error instanceof AIExtractionFailedError);
        assert.ok(!(error instanceof AITimeoutError), 'No debe confundirse con un timeout — ningún provider agotó el timeout acá.');
        return true;
      }
    );
  } finally {
    config.freeTextExtractionEnabled = originalFlag;
  }
});

test('extractSearchIntent (BE-09) resuelve zona en INDEFINIDA sin consultar zonesService cuando no hay location_mentions', async () => {
  const originalFlag = config.freeTextExtractionEnabled;
  config.freeTextExtractionEnabled = true;
  try {
    const fallback = new FallbackProvider([
      alwaysSucceeds('Gemini', {
        operation: 'alquiler', property_type: 'departamento', location_mentions: [],
        max_budget: null, currency: 'desconocido', bedrooms_min: 2, features: ['pileta'], country: 'indiferente'
      })
    ]);
    const result = await extractSearchIntentOp(fallback, 'busco depto 2 dorm con pileta');
    assert.strictEqual(result.intent.bedrooms_min, 2);
    assert.strictEqual(result.zone.zone_status, 'INDEFINIDA');
    assert.deepStrictEqual(result.zone.zona_ids, []);
    assert.deepStrictEqual(result.zone.zona_nombres, []);
  } finally {
    config.freeTextExtractionEnabled = originalFlag;
  }
});

// --- KAN-84: suggestExcelColumnMapping ---

test('suggestExcelColumnMapping (KAN-84) devuelve [] (no lanza) cuando todos los providers fallan', async () => {
  const fallback = new FallbackProvider([alwaysFails('Gemini'), alwaysFails('OpenAI')]);
  const result = await suggestExcelColumnMappingOp(fallback, ['Domicilio', 'Precio']);
  assert.deepStrictEqual(result, [], 'Debe devolver un array vacío (no un objeto por defecto ni una excepción) cuando ningún provider responde.');
});

test('suggestExcelColumnMapping (KAN-84) devuelve la respuesta validada de un provider exitoso', async () => {
  const mapping = [
    { field: 'domicilio', header: 'Dirección', confidence: 0.95 },
    { field: 'precio', header: null, confidence: 0 }
  ];
  const fallback = new FallbackProvider([alwaysSucceeds('Gemini', { mapping })]);
  const result = await suggestExcelColumnMappingOp(fallback, ['Dirección']);
  assert.deepStrictEqual(result, mapping);
});

test('suggestExcelColumnMapping (KAN-84) cae al siguiente provider si la respuesta no tiene el formato esperado', async () => {
  const mapping = [{ field: 'domicilio', header: 'Dirección', confidence: 0.9 }];
  const fallback = new FallbackProvider([
    makeFakeProvider('Gemini', async () => { throw new SchemaValidationError('mapping no es un array'); }),
    alwaysSucceeds('OpenAI', { mapping })
  ]);
  const result = await suggestExcelColumnMappingOp(fallback, ['Dirección']);
  assert.deepStrictEqual(result, mapping, 'Debe caer al siguiente provider cuando la respuesta del primero no tiene el formato esperado.');
});

// --- Segmentador ---

test('segmentSearchRequests (segmentador) - devuelve los segmentos cuando el provider detecta 2+ búsquedas independientes', async () => {
  const fallback = new FallbackProvider([
    alwaysSucceeds('Gemini', { segments: ['casa en barrio norte', 'departamento en barrio sur'] })
  ]);
  const result = await segmentSearchRequestsOp(fallback, 'casa en barrio norte. tambien depto en barrio sur');
  assert.deepStrictEqual(result, ['casa en barrio norte', 'departamento en barrio sur']);
});

test('segmentSearchRequests (segmentador) - fail-soft a [mensaje completo] cuando el provider devuelve un solo segmento', async () => {
  const freeText = 'busco depto 2 dorm en yerba buena';
  const fallback = new FallbackProvider([alwaysSucceeds('Gemini', { segments: [freeText] })]);
  const result = await segmentSearchRequestsOp(fallback, freeText);
  assert.deepStrictEqual(result, [freeText]);
});

test('segmentSearchRequests (segmentador) - fail-soft a [mensaje completo] cuando todos los providers fallan (nunca lanza)', async () => {
  const freeText = 'busco depto 2 dorm en yerba buena';
  const fallback = new FallbackProvider([alwaysFails('Gemini'), alwaysFails('OpenAI')]);
  const result = await segmentSearchRequestsOp(fallback, freeText);
  assert.deepStrictEqual(result, [freeText], 'Nunca debe lanzar ni bloquear POST /api/search — degrada al mensaje completo como única búsqueda.');
});
