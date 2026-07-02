import test from 'node:test';
import assert from 'node:assert';
import {
  OperationMatchingStrategy,
  PropertyTypeMatchingStrategy,
  CountryMatchingStrategy,
  ZoneMatchingStrategy,
  BedroomsMatchingStrategy,
  BudgetMatchingStrategy,
  FeaturesMatchingStrategy,
  resolvePropertyZoneId
} from '../src/utils/matcher';
import { ExtractedRealEstateRequest, ZoneIntentRequest } from '../src/services/ai';
import { Property } from '../src/services/excel';

function baseRequest(overrides: Partial<ExtractedRealEstateRequest> = {}): ExtractedRealEstateRequest {
  return {
    operation: 'venta',
    property_type: 'departamento',
    zones: [],
    max_budget: null,
    currency: 'ARS',
    bedrooms: null,
    key_features: [],
    country: 'indiferente',
    ...overrides
  };
}

function baseProperty(overrides: Partial<Property> = {}): Property {
  return {
    address: 'Av. Alem 500',
    price: 150000,
    currency: 'ARS',
    bedrooms: 2,
    features: '',
    property_type: 'departamento',
    operation: 'venta',
    sheet_name: 'Ventas',
    ...overrides
  };
}

// --- 1. Operation ---
test('Matcher - OperationMatchingStrategy: matchea con la misma operación', () => {
  const strategy = new OperationMatchingStrategy();
  const result = strategy.evaluate(baseRequest({ operation: 'venta' }), baseProperty({ operation: 'venta' }));
  assert.strictEqual(result.isMatch, true);
});

test('Matcher - OperationMatchingStrategy: rechaza con operación distinta', () => {
  const strategy = new OperationMatchingStrategy();
  const result = strategy.evaluate(baseRequest({ operation: 'venta' }), baseProperty({ operation: 'alquiler' }));
  assert.strictEqual(result.isMatch, false);
});

// --- 2. PropertyType ---
test('Matcher - PropertyTypeMatchingStrategy: matchea con el mismo tipo de propiedad', () => {
  const strategy = new PropertyTypeMatchingStrategy();
  const result = strategy.evaluate(baseRequest({ property_type: 'casa' }), baseProperty({ property_type: 'casa' }));
  assert.strictEqual(result.isMatch, true);
});

test('Matcher - PropertyTypeMatchingStrategy: rechaza con tipo de propiedad distinto', () => {
  const strategy = new PropertyTypeMatchingStrategy();
  const result = strategy.evaluate(baseRequest({ property_type: 'casa' }), baseProperty({ property_type: 'departamento' }));
  assert.strictEqual(result.isMatch, false);
});

// --- 3. Country ---
test('Matcher - CountryMatchingStrategy: matchea cuando se pide country y la propiedad está en uno', () => {
  const strategy = new CountryMatchingStrategy();
  const result = strategy.evaluate(baseRequest({ country: 'si' }), baseProperty({ address: 'Country El Bosque, lote 5' }));
  assert.strictEqual(result.isMatch, true);
});

test('Matcher - CountryMatchingStrategy: rechaza cuando se pide country y la propiedad no está en uno', () => {
  const strategy = new CountryMatchingStrategy();
  const result = strategy.evaluate(baseRequest({ country: 'si' }), baseProperty({ address: 'Av. Alem 500' }));
  assert.strictEqual(result.isMatch, false);
});

// --- 4. Zone / resolvePropertyZoneId ---
// Nota: resolvePropertyZoneId() NO es un stub que devuelve null (como afirma spec_0012) —
// delega en classifyPropertyZoneId(), un heurístico real de keywords. Se testea ese comportamiento real.
test('Matcher - resolvePropertyZoneId: no es un stub, clasifica por keywords reales', () => {
  assert.strictEqual(resolvePropertyZoneId(baseProperty({ address: 'Nogales 123' })), 'ZONA_LOS_NOGALES');
  assert.strictEqual(resolvePropertyZoneId(baseProperty({ address: 'Sin ninguna keyword conocida' })), 'DESCONOCIDO');
});

test('Matcher - ZoneMatchingStrategy: matchea cuando la zona resuelta coincide con la del zoneIntent', () => {
  const strategy = new ZoneMatchingStrategy();
  const zoneIntent: ZoneIntentRequest = {
    zona_id: 'ZONA_LOS_NOGALES',
    texto_ubicacion_original: 'nogales',
    dormitorios_min: null,
    caracteristicas_claves: [],
    operacion: 'DESCONOCIDO'
  };
  const result = strategy.evaluate(baseRequest(), baseProperty({ address: 'Nogales 123' }), zoneIntent);
  assert.strictEqual(result.isMatch, true);
});

test('Matcher - ZoneMatchingStrategy: rechaza cuando la zona resuelta no coincide con la del zoneIntent', () => {
  const strategy = new ZoneMatchingStrategy();
  const zoneIntent: ZoneIntentRequest = {
    zona_id: 'ZONA_LOS_NOGALES',
    texto_ubicacion_original: 'nogales',
    dormitorios_min: null,
    caracteristicas_claves: [],
    operacion: 'DESCONOCIDO'
  };
  const result = strategy.evaluate(baseRequest(), baseProperty({ address: 'Yerba Buena 500' }), zoneIntent);
  assert.strictEqual(result.isMatch, false);
});

// --- 5. Bedrooms ---
test('Matcher - BedroomsMatchingStrategy: matchea con la misma cantidad de dormitorios', () => {
  const strategy = new BedroomsMatchingStrategy();
  const result = strategy.evaluate(baseRequest({ bedrooms: 2 }), baseProperty({ bedrooms: 2 }));
  assert.strictEqual(result.isMatch, true);
  assert.strictEqual(result.scoreDeduction, 0);
});

test('Matcher - BedroomsMatchingStrategy: rechaza cuando faltan dormitorios', () => {
  const strategy = new BedroomsMatchingStrategy();
  const result = strategy.evaluate(baseRequest({ bedrooms: 3 }), baseProperty({ bedrooms: 2 }));
  assert.strictEqual(result.isMatch, false);
});

// --- 6. Budget ---
test('Matcher - BudgetMatchingStrategy: matchea cuando el precio está dentro del presupuesto', () => {
  const strategy = new BudgetMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest({ max_budget: 200000, currency: 'ARS' }),
    baseProperty({ price: 150000, currency: 'ARS' })
  );
  assert.strictEqual(result.isMatch, true);
  assert.strictEqual(result.scoreDeduction, 0);
});

test('Matcher - BudgetMatchingStrategy: rechaza cuando el precio excede el presupuesto (fuera del margen del 5%)', () => {
  const strategy = new BudgetMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest({ max_budget: 100000, currency: 'ARS' }),
    baseProperty({ price: 200000, currency: 'ARS' })
  );
  assert.strictEqual(result.isMatch, false);
});

// --- 7. Features ---
// Nota: esta estrategia nunca descarta (isMatch siempre true) — "rechazo" se traduce en
// una fuerte penalización de score cuando ninguna característica pedida está presente.
test('Matcher - FeaturesMatchingStrategy: matchea sin penalización cuando todas las características coinciden', () => {
  const strategy = new FeaturesMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest({ key_features: ['cochera'] }),
    baseProperty({ features: 'Cuenta con cochera y balcón' })
  );
  assert.strictEqual(result.isMatch, true);
  assert.strictEqual(result.scoreDeduction, 0);
});

test('Matcher - FeaturesMatchingStrategy: penaliza fuertemente el score cuando ninguna característica coincide', () => {
  const strategy = new FeaturesMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest({ key_features: ['pileta'] }),
    baseProperty({ features: 'Living amplio con balcón al frente' })
  );
  assert.strictEqual(result.isMatch, true);
  assert.ok(result.scoreDeduction > 0, 'Debe penalizar el score aunque no descarte el match.');
});
