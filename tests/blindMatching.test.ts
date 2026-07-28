import test from 'node:test';
import assert from 'node:assert';
import { matchRequestAgainstProperties } from '../src/services/blindMatching';
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
