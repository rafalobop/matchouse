import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

// 1. Probar caché de clientes Supabase
import { getTenantClient } from '../src/services/supabase';

test('Supabase Client Cache - Debería retornar el mismo cliente para el mismo token', () => {
  const token1 = 'dummy-token-a';
  const token2 = 'dummy-token-a';
  const token3 = 'dummy-token-b';

  const client1 = getTenantClient(token1);
  const client2 = getTenantClient(token2);
  const client3 = getTenantClient(token3);

  assert.strictEqual(client1, client2, 'Los clientes con el mismo token deberían ser idénticos.');
  assert.notStrictEqual(client1, client3, 'Los clientes con diferentes tokens no deberían ser idénticos.');
});

// 3. Probar Dolar Blue Service
import { getDolarBlueRate, loadCachedRate, updateDolarRate } from '../src/services/dolar';

test('Dolar Service - Debería retornar cotizaciones válidas y persistir caché', async () => {
  // Cargar tasa
  const rate = loadCachedRate();
  assert.ok(typeof rate === 'number' && rate > 0, 'La tasa inicial debe ser un número positivo.');

  // Consultar la API real
  const currentRate = await updateDolarRate();
  assert.ok(currentRate > 0, 'La cotización real debe ser positiva.');
  
  // Comprobar que el valor en memoria coincide
  assert.strictEqual(getDolarBlueRate(), currentRate, 'El valor expuesto en getDolarBlueRate() debe coincidir con el consultado.');

  // Comprobar que existe la caché en disco
  const cachePath = path.join(process.cwd(), 'cache', 'dolar_blue.json');
  assert.ok(fs.existsSync(cachePath), 'El archivo de caché dolar_blue.json debió haberse creado.');
  
  const cachedContent = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  assert.strictEqual(cachedContent.rate, currentRate, 'El precio guardado en el archivo debe ser igual al actual.');
});

// 4. Probar conversión dinámica en Matcher
import { checkMatch } from '../src/utils/matcher';
import { Property } from '../src/services/excel';
import { ExtractedRealEstateRequest } from '../src/services/ai';

test('Matcher - Conversión dinámica usando cotización dinámica de dólar', () => {
  const currentDolar = getDolarBlueRate();

  const property: Property = {
    address: 'Calle Test 123',
    unit: '',
    price: currentDolar * 100, // Equivale exactamente a 100 USD en pesos
    currency: 'ARS',
    maintenance_fees: 0,
    bedrooms: 2,
    features: 'Lindo departamento con patio',
    contact_info: '123456789',
    zone_display_name: 'Yerba Buena',
    operation: 'alquiler',
    property_type: 'departamento',
    sheet_name: 'Alquileres'
  };

  const request: ExtractedRealEstateRequest = {
    operation: 'alquiler',
    property_type: 'departamento',
    zones: ['Yerba Buena'],
    max_budget: 101, // Presupuesto de 101 USD (la propiedad cuesta 100 USD al cambio)
    currency: 'USD',
    bedrooms: 2,
    key_features: [],
    country: 'indiferente'
  };

  const result = checkMatch(request, property);
  assert.ok(result.isMatch, 'La propiedad debió matchear ya que entra en el presupuesto convertido.');

  // Ahora bajamos el presupuesto a 90 USD (la propiedad cuesta 100 USD, debería fallar)
  request.max_budget = 90;
  const resultFailed = checkMatch(request, property);
  assert.ok(!resultFailed.isMatch, 'La propiedad no debió matchear ya que excede el presupuesto.');
});
