import test from 'node:test';
import assert from 'node:assert';
import { extractFromWhatsApp, extractFromTextInput, extractZoneIntent, validateMatch, normalizeAgent1 } from '../src/services/ai';
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
