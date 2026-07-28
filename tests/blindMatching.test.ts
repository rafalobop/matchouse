import test from 'node:test';
import assert from 'node:assert';
import { matchRequestAgainstProperties, mapDbRowToProperty } from '../src/services/blindMatching';
import { ExtractedRealEstateRequest } from '../src/services/ai';
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

test('BlindMatching - matchRequestAgainstProperties: descarta candidatos que no matchean (checkMatch isMatch=false)', () => {
  const request = baseRequest({ operation: 'venta' });
  const candidates = [
    { tenant_id: 'tenant-b', property: baseProperty({ operation: 'alquiler' }) }
  ];

  const result = matchRequestAgainstProperties(request, candidates);

  assert.strictEqual(result.length, 0, 'Una propiedad con operación distinta no debe aparecer en los resultados.');
});

test('BlindMatching - matchRequestAgainstProperties: atribuye el tenant_id correcto a cada match', () => {
  const request = baseRequest();
  const candidates = [
    { tenant_id: 'tenant-b', property: baseProperty({ address: 'Prop de B' }) }
  ];

  const result = matchRequestAgainstProperties(request, candidates);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].tenant_id, 'tenant-b');
  assert.strictEqual(result[0].property.address, 'Prop de B');
});

test('BlindMatching - matchRequestAgainstProperties: ordena los resultados de mayor a menor score', () => {
  const request = baseRequest({ key_features: ['pileta'] });
  const candidates = [
    { tenant_id: 'tenant-low', property: baseProperty({ address: 'Sin pileta', features: 'Living amplio' }) },
    { tenant_id: 'tenant-high', property: baseProperty({ address: 'Con pileta', features: 'Cuenta con pileta climatizada' }) }
  ];

  const result = matchRequestAgainstProperties(request, candidates);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].tenant_id, 'tenant-high', 'El match con mejor score (características coincidentes) debe ir primero.');
  assert.ok(result[0].score > result[1].score);
});

test('BlindMatching - matchRequestAgainstProperties: excluye implícitamente la cartera propia si el caller no la incluye en los candidatos', () => {
  // findCrossTenantMatches es quien filtra con .neq('tenant_id', tenantId) a nivel de query;
  // esta función pura solo debe operar sobre lo que recibe, sin conocer el tenant que busca.
  const request = baseRequest();
  const result = matchRequestAgainstProperties(request, []);

  assert.deepStrictEqual(result, []);
});

// Regresión (hallazgo de QA en KAN-37): mapDbRowToProperty() no seteaba zone_display_name al
// reconstruir un Property desde una fila de `properties`, a diferencia de los otros dos lugares
// del repo que hacen ese mismo trabajo (src/index.ts#main(), src/services/whatsapp.ts). Efecto
// real observado por QA: una búsqueda con zona nunca matcheaba ninguna propiedad cross-tenant,
// aunque coincidiera en todo lo demás (operación, tipo, dormitorios, presupuesto, características).
test('BlindMatching - mapDbRowToProperty: reconstruye zone_display_name a partir de sheet_name (regresión QA KAN-37)', () => {
  const row = { sheet_name: 'Alquiler YB', address: 'Calle Test 123', price: 1000, currency: 'USD', bedrooms: 1, operation: 'alquiler', property_type: 'departamento' };

  const property = mapDbRowToProperty(row);

  assert.strictEqual(property.zone_display_name, 'Alquiler YB', 'zone_display_name debe reconstruirse desde sheet_name, igual que en index.ts y whatsapp.ts.');
});

test('BlindMatching - findCrossTenantMatches (regresión QA KAN-37): una búsqueda con zona matchea una propiedad cross-tenant cuya zona coincide', () => {
  const dbRow = {
    tenant_id: 'tenant-b',
    address: 'Yerba Buena 1500',
    price: 120000,
    currency: 'USD',
    maintenance_fees: 0,
    bedrooms: 2,
    features: 'Pileta y cochera',
    contact_info: '',
    operation: 'venta',
    property_type: 'departamento',
    sheet_name: 'Yerba Buena',
    latitude: 0,
    longitude: 0
  };

  const candidate = { tenant_id: dbRow.tenant_id, property: mapDbRowToProperty(dbRow) };
  const request = baseRequest({ zones: ['Yerba Buena'], key_features: ['pileta', 'cochera'], bedrooms: 2, max_budget: 150000, currency: 'USD' });

  const result = matchRequestAgainstProperties(request, [candidate]);

  assert.strictEqual(result.length, 1, 'Antes del fix, esta búsqueda con zona no devolvía ningún match aunque coincidiera en todo lo demás.');
  assert.strictEqual(result[0].tenant_id, 'tenant-b');
});
