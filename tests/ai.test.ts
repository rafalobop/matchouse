import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import {
  extractFromTextInput,
  extractZoneIntent,
  segmentSearchRequests,
  suggestExcelColumnMapping,
  GeminiProvider,
  OpenAIProvider,
  FallbackProvider,
  AllProvidersFailedError,
  SchemaValidationError,
  ExtractIntentSchema,
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

test('AI Service - Debería exportar las funciones clave (KAN-36: extractFromTextInput)', () => {
  assert.strictEqual(typeof extractFromTextInput, 'function', 'extractFromTextInput debe ser una función.');
  assert.strictEqual(typeof extractZoneIntent, 'function', 'extractZoneIntent debe ser una función.');
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

test('AI Service - extractFromTextInput (KAN-36) rechaza sin llamar a ningún proveedor de IA cuando el flag está deshabilitado', async () => {
  const original = config.freeTextExtractionEnabled;
  try {
    config.freeTextExtractionEnabled = false;
    await assert.rejects(
      () => extractFromTextInput('busco depto 2 dorm en yerba buena hasta 80000 usd'),
      /FREE_TEXT_EXTRACTION_ENABLED/,
      'Con el flag deshabilitado, extractFromTextInput debe rechazar de inmediato mencionando el flag.'
    );
  } finally {
    config.freeTextExtractionEnabled = original;
  }
});

test('AI Service - ExtractIntentSchema (BE-06) acepta/rechaza variaciones del Agente 1 igual que antes normalizeAgent1', () => {
  const casoCompleto = {
    operation: 'venta', property_type: 'departamento', zones: ['Yerba Buena'], max_budget: 80000,
    currency: 'USD', bedrooms: 2, key_features: ['cochera', 'pileta'], country: 'no'
  };
  assert.strictEqual(ExtractIntentSchema.safeParse(casoCompleto).success, true, 'Un caso bien formado debe pasar el schema.');

  // BE-06: a diferencia de normalizeAgent1 (que corregía/defaulteaba en silencio), un enum en
  // mayúsculas o inventado ahora es un fallo de schema explícito — decisión de diseño documentada:
  // la validación de schema se encarga de la FORMA, las decisiones de negocio (qué hacer ante un
  // fallo total de todos los proveedores) siguen en las operaciones (ver AIExtractionFailedError).
  const casoMayusculas = { ...casoCompleto, operation: 'VENTA' };
  assert.strictEqual(ExtractIntentSchema.safeParse(casoMayusculas).success, false, 'Un enum en mayúsculas debe fallar el schema (los providers ya fuerzan minúsculas vía structured output).');

  const casoEnumInventado = { ...casoCompleto, property_type: 'mansion' };
  assert.strictEqual(ExtractIntentSchema.safeParse(casoEnumInventado).success, false, 'Un enum fuera de la lista debe fallar el schema.');

  const casoSinCampos = {};
  assert.strictEqual(ExtractIntentSchema.safeParse(casoSinCampos).success, false, 'Campos faltantes deben fallar el schema (son todos requeridos, incluso los nullable).');

  const casoNulls = { ...casoCompleto, max_budget: null, bedrooms: null };
  assert.strictEqual(ExtractIntentSchema.safeParse(casoNulls).success, true, 'max_budget/bedrooms nullable deben aceptar null.');
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
      () => provider.generateStructured({ op: 'extract-intent', system: 'instrucción', user: 'texto', schema: ExtractIntentSchema }),
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
        () => provider.generateStructured({ op: 'extract-intent', system: 'instrucción', user: 'texto', schema: ExtractIntentSchema }),
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

// --- Fakes de LLMProvider para probar FallbackProvider y las 4 operaciones sin red real ---
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

// --- KAN-70/KAN-339: extractFromTextInput y la distinción AITimeoutError vs AIExtractionFailedError ---
// Estos tests inyectan providers fake directo en un FallbackProvider de prueba — necesitan pasar
// por `extractFromTextInput` real (no un fake standalone) para probar
// la lógica de clasificación de errores que vive en src/ai/operations/extractIntent.ts, así que se
// llama a la implementación interna importando el módulo de operación directamente.

import { extractFromTextInput as extractFromTextInputOp } from '../src/ai/operations/extractIntent';
import { extractZoneIntent as extractZoneIntentOp } from '../src/ai/operations/extractZoneIntent';
import { segmentSearchRequests as segmentSearchRequestsOp } from '../src/ai/operations/segment';
import { suggestExcelColumnMapping as suggestExcelColumnMappingOp } from '../src/ai/operations/excelMapping';

test('extractFromTextInput (KAN-70) lanza AITimeoutError cuando TODOS los providers agotan el timeout', async () => {
  const originalFlag = config.freeTextExtractionEnabled;
  config.freeTextExtractionEnabled = true;
  try {
    const fallback = new FallbackProvider([
      alwaysFails('Gemini', new TimeoutError('Timeout simulado de Gemini (KAN-70)')),
      alwaysFails('OpenAI', new TimeoutError('Timeout simulado de OpenAI (KAN-70)'))
    ]);
    await assert.rejects(
      () => extractFromTextInputOp(fallback, 'busco depto 2 dorm en yerba buena hasta 80000 usd'),
      (error: any) => {
        assert.ok(error instanceof AITimeoutError, 'Debe lanzar AITimeoutError cuando todos los providers agotan el timeout, en vez de devolver el fallback silencioso.');
        return true;
      }
    );
  } finally {
    config.freeTextExtractionEnabled = originalFlag;
  }
});

test('extractFromTextInput (KAN-70/KAN-339) lanza AIExtractionFailedError (no AITimeoutError) si al menos un provider falló por un motivo distinto a timeout', async () => {
  const originalFlag = config.freeTextExtractionEnabled;
  config.freeTextExtractionEnabled = true;
  try {
    const fallback = new FallbackProvider([
      alwaysFails('Gemini', new TimeoutError('Timeout simulado de Gemini (KAN-70)')),
      alwaysFails('OpenAI', new Error('Cuota excedida (no es timeout)'))
    ]);
    await assert.rejects(
      () => extractFromTextInputOp(fallback, 'busco depto 2 dorm en yerba buena hasta 80000 usd'),
      (error: any) => {
        assert.ok(error instanceof AIExtractionFailedError, 'KAN-339: un fallo mixto (un timeout + un fallo real) debe lanzar AIExtractionFailedError, no degradar en silencio a criterios comodín.');
        return true;
      }
    );
  } finally {
    config.freeTextExtractionEnabled = originalFlag;
  }
});

test('extractFromTextInput (KAN-339) lanza AIExtractionFailedError cuando TODOS los providers fallan por un motivo que no es timeout', async () => {
  const originalFlag = config.freeTextExtractionEnabled;
  config.freeTextExtractionEnabled = true;
  try {
    const fallback = new FallbackProvider([
      alwaysFails('Gemini', new Error('Cuota excedida (no es timeout)')),
      alwaysFails('OpenAI', new Error('Respuesta con schema inválido (no es timeout)'))
    ]);
    await assert.rejects(
      () => extractFromTextInputOp(fallback, 'busco depto 2 dorm en yerba buena hasta 80000 usd'),
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

// --- Estados de zona (2026-08-11): toZoneIntentPlaceholder / resolveZoneIntent / segmentSearchRequests ---

test('extractZoneIntent (estados de zona) - sin ubicaciones mencionadas, resuelve INDEFINIDA sin consultar zonesService', async () => {
  const fallback = new FallbackProvider([
    alwaysSucceeds('Gemini', { ubicaciones: [], dormitorios_min: 2, caracteristicas_claves: ['pileta'], operacion: 'ALQUILER' })
  ]);
  const result = await extractZoneIntentOp(fallback, 'busco depto 2 dorm con pileta');
  assert.strictEqual(result.zone_status, 'INDEFINIDA');
  assert.deepStrictEqual(result.zona_ids, []);
  assert.deepStrictEqual(result.zona_nombres, []);
  assert.strictEqual(result.dormitorios_min, 2);
});

test('extractZoneIntent (estados de zona) - fallo total de todos los providers degrada a INDEFINIDA (no DESCONOCIDA)', async () => {
  const fallback = new FallbackProvider([alwaysFails('Gemini'), alwaysFails('OpenAI')]);
  const result = await extractZoneIntentOp(fallback, 'busco algo');
  assert.strictEqual(result.zone_status, 'INDEFINIDA', 'Un fallo total del LLM no es evidencia de que el usuario mencionó una zona real, así que no debe bloquear (DESCONOCIDA).');
  assert.deepStrictEqual(result.zona_ids, []);
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
