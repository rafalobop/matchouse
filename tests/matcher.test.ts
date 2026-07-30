import test from 'node:test';
import assert from 'node:assert';
import {
  OperationMatchingStrategy,
  PropertyTypeMatchingStrategy,
  CountryMatchingStrategy,
  ZoneMatchingStrategy,
  BedroomsMatchingStrategy,
  BudgetMatchingStrategy,
  FeaturesMatchingStrategy
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

// --- 4. Zone (KAN-22) ---
// Desde KAN-22, ZoneMatchingStrategy ya NO resuelve la zona de la propiedad por su cuenta (era un
// heurístico de keywords hardcodeado, classifyPropertyZoneId, borrado en este ticket). Ahora es
// puramente sync: compara zoneIntent.zona_id (UUID de neighborhoods.id, resuelto por PostGIS/alias
// en zonesService.ts) contra property.neighborhood_id, que ya viene pre-estampado por
// blindMatching.ts#findCrossTenantMatches ANTES de llegar acá. Estos tests simulan ese
// pre-estampado seteando neighborhood_id directamente en la property, sin tocar Supabase.
const BARRIO_NORTE_ID = 'a1a1a1a1-0000-0000-0000-000000000001';
const BARRIO_SUR_ID = 'b2b2b2b2-0000-0000-0000-000000000002';

function zoneIntentFor(zonaId: string): ZoneIntentRequest {
  return {
    zona_id: zonaId,
    texto_ubicacion_original: 'texto de prueba',
    dormitorios_min: null,
    caracteristicas_claves: [],
    operacion: 'DESCONOCIDO'
  };
}

test('Matcher - ZoneMatchingStrategy: matchea cuando el neighborhood_id de la propiedad coincide con el del zoneIntent', () => {
  const strategy = new ZoneMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest(),
    baseProperty({ neighborhood_id: BARRIO_NORTE_ID }),
    zoneIntentFor(BARRIO_NORTE_ID)
  );
  assert.strictEqual(result.isMatch, true);
});

// AC KAN-22: una búsqueda de Barrio Norte no debe matchear una propiedad en Barrio Sur.
test('Matcher - ZoneMatchingStrategy (AC KAN-22): una búsqueda en Barrio Norte NO matchea una propiedad en Barrio Sur', () => {
  const strategy = new ZoneMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest(),
    baseProperty({ address: 'Barrio Sur 456', neighborhood_id: BARRIO_SUR_ID }),
    zoneIntentFor(BARRIO_NORTE_ID)
  );
  assert.strictEqual(result.isMatch, false, 'Barrio Norte y Barrio Sur son zonas distintas, no deben matchear entre sí.');
});

test('Matcher - ZoneMatchingStrategy: rechaza cuando la propiedad no tiene zona resuelta (neighborhood_id null/undefined) y el pedido pide una zona concreta', () => {
  const strategy = new ZoneMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest(),
    baseProperty({ neighborhood_id: null }),
    zoneIntentFor(BARRIO_NORTE_ID)
  );
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

// KAN-72: price <= 0 es dato faltante (Excel con precio no parseable, ver excel.test.ts), no un
// precio real de $0 — no debe descartarse por presupuesto, pero el motivo debe quedar explícito.
test('Matcher - BudgetMatchingStrategy: trata price=0 como dato faltante, no lo descarta y deja motivo explícito', () => {
  const strategy = new BudgetMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest({ max_budget: 100000, currency: 'ARS' }),
    baseProperty({ price: 0, currency: 'ARS' })
  );
  assert.strictEqual(result.isMatch, true, 'No debe descartar la propiedad solo por no tener precio cargado.');
  assert.strictEqual(result.scoreDeduction, 0);
  assert.ok(result.reason && result.reason.includes('no tiene un precio cargado'), 'Debe dejar explícito que faltan datos de precio.');
});

test('Matcher - BudgetMatchingStrategy: trata price negativo igual que price=0 (dato faltante)', () => {
  const strategy = new BudgetMatchingStrategy();
  const result = strategy.evaluate(
    baseRequest({ max_budget: 100000, currency: 'ARS' }),
    baseProperty({ price: -1, currency: 'ARS' })
  );
  assert.strictEqual(result.isMatch, true);
  assert.ok(result.reason && result.reason.includes('no tiene un precio cargado'));
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
