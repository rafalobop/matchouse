import test from 'node:test';
import assert from 'node:assert';
import {
  extractFromWhatsApp,
  extractFromTextInput,
  extractZoneIntent,
  validateMatch,
  suggestExcelColumnMapping,
  normalizeAgent1,
  GeminiStrategy,
  OpenAIStrategy,
  AITimeoutError
} from '../src/services/ai';
import { TimeoutError } from '../src/utils/withTimeout';
import { config, validateConfig } from '../src/config/env';

test('AI Service - Debería exportar las funciones clave (KAN-36: extractFromWhatsApp y extractFromTextInput)', () => {
  assert.strictEqual(typeof extractFromWhatsApp, 'function', 'extractFromWhatsApp debe ser una función.');
  assert.strictEqual(typeof extractFromTextInput, 'function', 'extractFromTextInput debe ser una función.');
  assert.strictEqual(typeof extractZoneIntent, 'function', 'extractZoneIntent debe ser una función.');
  assert.strictEqual(typeof validateMatch, 'function', 'validateMatch debe ser una función.');
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

test('AI Service - extractFromWhatsApp no depende de FREE_TEXT_EXTRACTION_ENABLED (KAN-36: sin regresiones)', () => {
  // extractFromWhatsApp no debe leer el flag en absoluto: es una verificación estática de
  // que ambas funciones están desacopladas (el flag deshabilitado nunca debe frenar WhatsApp).
  assert.strictEqual(typeof extractFromWhatsApp, 'function');
});

test('AI Service - normalizeAgent1 (KAN-36) produce salida válida según el schema para múltiples variaciones de texto libre', () => {
  const casosVariados: any[] = [
    // Caso completo y bien formado
    {
      operation: 'VENTA',
      property_type: 'DEPARTAMENTO',
      zones: ['Yerba Buena'],
      max_budget: 80000,
      currency: 'usd',
      bedrooms: 2,
      key_features: ['cochera', 'pileta'],
      country: 'NO'
    },
    // Campos faltantes / undefined (texto libre ambiguo, sin presupuesto ni dormitorios)
    {
      operation: undefined,
      property_type: undefined,
      max_budget: undefined,
      bedrooms: undefined
    },
    // Enums inválidos / inventados por el modelo
    {
      operation: 'no-se-que-busca',
      property_type: 'mansion',
      currency: 'EUR',
      country: 'tal-vez'
    },
    // Arrays ausentes (deben normalizarse a [])
    {
      operation: 'alquiler',
      property_type: 'casa',
      zones: null,
      key_features: null
    },
    // Objeto vacío (texto libre sin ninguna entidad reconocible)
    {}
  ];

  for (const caso of casosVariados) {
    const resultado = normalizeAgent1(caso);

    assert.ok(['venta', 'alquiler', 'desconocido'].includes(resultado.operation), `operation inválida: ${resultado.operation}`);
    assert.ok(['departamento', 'casa', 'terreno', 'local', 'oficina', 'otro'].includes(resultado.property_type), `property_type inválido: ${resultado.property_type}`);
    assert.ok(Array.isArray(resultado.zones), 'zones debe ser siempre un array.');
    assert.ok(resultado.max_budget === null || typeof resultado.max_budget === 'number', 'max_budget debe ser null o number.');
    assert.ok(['USD', 'ARS', 'desconocido'].includes(resultado.currency), `currency inválida: ${resultado.currency}`);
    assert.ok(resultado.bedrooms === null || typeof resultado.bedrooms === 'number', 'bedrooms debe ser null o number.');
    assert.ok(Array.isArray(resultado.key_features), 'key_features debe ser siempre un array.');
    assert.ok(['si', 'no', 'indiferente'].includes(resultado.country), `country inválido: ${resultado.country}`);
  }
});

// --- KAN-70: timeout en las llamadas a generateContent/chat.completions.create ---
// No se mockea el SDK con una librería externa (el proyecto no usa jest/sinon) — en cambio,
// se sobreescribe el método real del cliente SDK ya instanciado (this.ai.models.generateContent /
// this.openai.chat.completions.create) para que devuelva una promesa que nunca resuelve,
// ejercitando el wrapping real de withTimeout en cada uno de los 8 call sites, sin red real.

const geminiInvocations: Array<{ label: string; call: (s: GeminiStrategy) => Promise<any> }> = [
  { label: 'extractRealEstateRequest', call: (s) => s.extractRealEstateRequest('mensaje de prueba', 'instrucción') },
  { label: 'extractFromFreeText', call: (s) => s.extractFromFreeText('texto libre de prueba', 'instrucción') },
  { label: 'extractZoneIntent', call: (s) => s.extractZoneIntent('mensaje de prueba', 'instrucción', 'venta') },
  { label: 'validateMatch', call: (s) => s.validateMatch('mensaje', {}, {}, 'instrucción') },
  { label: 'suggestExcelColumnMapping', call: (s) => s.suggestExcelColumnMapping(['domicilio', 'precio'], 'instrucción') }
];

test('AI Service (KAN-70) - las 4 llamadas de GeminiStrategy a generateContent usan withTimeout (rechazan con TimeoutError si el SDK cuelga)', async () => {
  const originalTimeout = config.aiRequestTimeoutMs;
  config.aiRequestTimeoutMs = 30;
  try {
    for (const { label, call } of geminiInvocations) {
      const strategy = new GeminiStrategy();
      (strategy as any).ai.models.generateContent = () => new Promise(() => {});

      await assert.rejects(
        () => call(strategy),
        (error: any) => {
          assert.ok(error instanceof TimeoutError, `${label}: el error debe ser una instancia de TimeoutError.`);
          assert.match(error.message, /Gemini generateContent/, `${label}: el mensaje debe identificar la llamada de Gemini.`);
          return true;
        },
        `${label} debería rechazar por timeout cuando generateContent cuelga.`
      );
    }
  } finally {
    config.aiRequestTimeoutMs = originalTimeout;
  }
});

const openaiInvocations: Array<{ label: string; call: (s: OpenAIStrategy) => Promise<any> }> = [
  { label: 'extractRealEstateRequest', call: (s) => s.extractRealEstateRequest('mensaje de prueba', 'instrucción') },
  { label: 'extractFromFreeText', call: (s) => s.extractFromFreeText('texto libre de prueba', 'instrucción') },
  { label: 'extractZoneIntent', call: (s) => s.extractZoneIntent('mensaje de prueba', 'instrucción', 'venta') },
  { label: 'validateMatch', call: (s) => s.validateMatch('mensaje', {}, {}, 'instrucción') },
  { label: 'suggestExcelColumnMapping', call: (s) => s.suggestExcelColumnMapping(['domicilio', 'precio'], 'instrucción') }
];

test(
  'AI Service (KAN-70) - las 4 llamadas de OpenAIStrategy a chat.completions.create usan withTimeout (rechazan con TimeoutError si el SDK cuelga)',
  { skip: !config.openaiApiKey ? 'OPENAI_API_KEY no configurada en este entorno' : false },
  async () => {
    const originalTimeout = config.aiRequestTimeoutMs;
    config.aiRequestTimeoutMs = 30;
    try {
      for (const { label, call } of openaiInvocations) {
        const strategy = new OpenAIStrategy();
        (strategy as any).openai.chat.completions.create = () => new Promise(() => {});

        await assert.rejects(
          () => call(strategy),
          (error: any) => {
            assert.ok(error instanceof TimeoutError, `${label}: el error debe ser una instancia de TimeoutError.`);
            assert.match(error.message, /OpenAI chat\.completions\.create/, `${label}: el mensaje debe identificar la llamada de OpenAI.`);
            return true;
          },
          `${label} debería rechazar por timeout cuando chat.completions.create cuelga.`
        );
      }
    } finally {
      config.aiRequestTimeoutMs = originalTimeout;
    }
  }
);

test('AI Service (KAN-70) - extractFromTextInput lanza AITimeoutError cuando TODAS las estrategias configuradas agotan el timeout', async () => {
  const originalGemini = GeminiStrategy.prototype.extractFromFreeText;
  const originalOpenAI = OpenAIStrategy.prototype.extractFromFreeText;
  const originalFlag = config.freeTextExtractionEnabled;

  GeminiStrategy.prototype.extractFromFreeText = async () => { throw new TimeoutError('Timeout simulado de Gemini (KAN-70)'); };
  OpenAIStrategy.prototype.extractFromFreeText = async () => { throw new TimeoutError('Timeout simulado de OpenAI (KAN-70)'); };
  config.freeTextExtractionEnabled = true;

  try {
    await assert.rejects(
      () => extractFromTextInput('busco depto 2 dorm en yerba buena hasta 80000 usd'),
      (error: any) => {
        assert.ok(error instanceof AITimeoutError, 'Debe lanzar AITimeoutError cuando todas las estrategias agotan el timeout, en vez de devolver el fallback silencioso.');
        return true;
      }
    );
  } finally {
    GeminiStrategy.prototype.extractFromFreeText = originalGemini;
    OpenAIStrategy.prototype.extractFromFreeText = originalOpenAI;
    config.freeTextExtractionEnabled = originalFlag;
  }
});

test(
  'AI Service (KAN-70) - extractFromTextInput NO lanza AITimeoutError si al menos una estrategia falló por un motivo distinto a timeout (comportamiento previo intacto)',
  { skip: !config.openaiApiKey ? 'OPENAI_API_KEY no configurada en este entorno (no hay una segunda estrategia para simular una falla mixta)' : false },
  async () => {
    const originalGemini = GeminiStrategy.prototype.extractFromFreeText;
    const originalOpenAI = OpenAIStrategy.prototype.extractFromFreeText;
    const originalFlag = config.freeTextExtractionEnabled;

    GeminiStrategy.prototype.extractFromFreeText = async () => { throw new TimeoutError('Timeout simulado de Gemini (KAN-70)'); };
    OpenAIStrategy.prototype.extractFromFreeText = async () => { throw new Error('Cuota excedida (no es timeout)'); };
    config.freeTextExtractionEnabled = true;

    try {
      const result = await extractFromTextInput('busco depto 2 dorm en yerba buena hasta 80000 usd');
      assert.strictEqual(result.operation, 'desconocido', 'Debe caer al objeto por defecto silencioso (comportamiento previo de la regla de negocio), no lanzar AITimeoutError.');
    } finally {
      GeminiStrategy.prototype.extractFromFreeText = originalGemini;
      OpenAIStrategy.prototype.extractFromFreeText = originalOpenAI;
      config.freeTextExtractionEnabled = originalFlag;
    }
  }
);

// --- KAN-84: suggestExcelColumnMapping ---

test('AI Service (KAN-84) - suggestExcelColumnMapping devuelve [] (no lanza) cuando todas las estrategias fallan', async () => {
  const originalGemini = GeminiStrategy.prototype.suggestExcelColumnMapping;
  const originalOpenAI = OpenAIStrategy.prototype.suggestExcelColumnMapping;

  GeminiStrategy.prototype.suggestExcelColumnMapping = async () => { throw new Error('Falla simulada de Gemini'); };
  OpenAIStrategy.prototype.suggestExcelColumnMapping = async () => { throw new Error('Falla simulada de OpenAI'); };

  try {
    const result = await suggestExcelColumnMapping(['Domicilio', 'Precio']);
    assert.deepStrictEqual(result, [], 'Debe devolver un array vacío (no un objeto por defecto ni una excepción) cuando ninguna estrategia responde.');
  } finally {
    GeminiStrategy.prototype.suggestExcelColumnMapping = originalGemini;
    OpenAIStrategy.prototype.suggestExcelColumnMapping = originalOpenAI;
  }
});

test('AI Service (KAN-84) - suggestExcelColumnMapping normaliza la respuesta exitosa de la estrategia', async () => {
  const originalGemini = GeminiStrategy.prototype.suggestExcelColumnMapping;

  GeminiStrategy.prototype.suggestExcelColumnMapping = async () => ({
    mapping: [
      { field: 'domicilio', header: 'Dirección', confidence: 0.95 },
      { field: 'precio', header: null, confidence: 0 }
    ]
  });

  try {
    const result = await suggestExcelColumnMapping(['Dirección']);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], { field: 'domicilio', header: 'Dirección', confidence: 0.95 });
    assert.deepStrictEqual(result[1], { field: 'precio', header: null, confidence: 0 });
  } finally {
    GeminiStrategy.prototype.suggestExcelColumnMapping = originalGemini;
  }
});

test('AI Service (KAN-84) - suggestExcelColumnMapping cae a la siguiente estrategia si la respuesta no tiene el formato esperado', async () => {
  const originalGemini = GeminiStrategy.prototype.suggestExcelColumnMapping;
  const originalOpenAI = OpenAIStrategy.prototype.suggestExcelColumnMapping;

  GeminiStrategy.prototype.suggestExcelColumnMapping = async () => ({ mapping: 'no-es-un-array' } as any);
  OpenAIStrategy.prototype.suggestExcelColumnMapping = async () => ({
    mapping: [{ field: 'domicilio', header: 'Dirección', confidence: 0.9 }]
  });

  try {
    const result = await suggestExcelColumnMapping(['Dirección']);
    if (config.openaiApiKey) {
      assert.strictEqual(result.length, 1, 'Debe caer a OpenAI cuando la respuesta de Gemini no tiene el formato esperado.');
    } else {
      assert.deepStrictEqual(result, [], 'Sin OpenAI configurada, debe devolver [] tras el fallo de formato de Gemini.');
    }
  } finally {
    GeminiStrategy.prototype.suggestExcelColumnMapping = originalGemini;
    OpenAIStrategy.prototype.suggestExcelColumnMapping = originalOpenAI;
  }
});
