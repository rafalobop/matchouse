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

// 2. Probar colas de mensajes aisladas por Tenant
import { AsyncMessageQueue } from '../src/utils/queue';

test('Isolated Multi-Tenant Queue - Las colas de cada tenant no deberían bloquearse entre sí', async () => {
  // Inicializamos una cola con delay corto para las pruebas
  const testQueue = new AsyncMessageQueue(200);

  const startTimes: Record<string, number> = {};
  const completionTimes: Record<string, number> = {};

  const taskA1 = () => new Promise<void>((resolve) => {
    startTimes['A1'] = Date.now();
    setTimeout(() => {
      completionTimes['A1'] = Date.now();
      resolve();
    }, 100);
  });

  const taskA2 = () => new Promise<void>((resolve) => {
    startTimes['A2'] = Date.now();
    completionTimes['A2'] = Date.now();
    resolve();
  });

  const taskB1 = () => new Promise<void>((resolve) => {
    startTimes['B1'] = Date.now();
    completionTimes['B1'] = Date.now();
    resolve();
  });

  // Encolar tareas para Tenant A y Tenant B
  testQueue.enqueue(taskA1, 'tenant-A');
  testQueue.enqueue(taskA2, 'tenant-A');
  
  // Encolar tarea para Tenant B inmediatamente
  testQueue.enqueue(taskB1, 'tenant-B');

  // Esperar a que se procese todo
  await new Promise((resolve) => setTimeout(resolve, 800));

  // A1 se ejecuta inmediatamente
  assert.ok(startTimes['A1'] !== undefined, 'La tarea A1 debió ejecutarse.');
  
  // A2 debe ejecutarse con retraso después de A1 (debido al delayMs de 200ms de la cola del tenant A)
  assert.ok(startTimes['A2'] >= completionTimes['A1'] + 150, 'La tarea A2 debió esperar el rate limit de su propia cola.');

  // B1 debió ejecutarse de inmediato de forma paralela sin esperar al delay ni al término de A1 o A2
  assert.ok(startTimes['B1'] < startTimes['A2'], 'La tarea de Tenant B no debió bloquearse por la cola de Tenant A.');
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
import { Property } from '../src/services/sheets';
import { ExtractedRealEstateRequest } from '../src/services/ai';

test('Matcher - Conversión dinámica usando cotización dinámica de dólar', () => {
  const currentDolar = getDolarBlueRate();

  const property: Property = {
    domicilio: 'Calle Test 123',
    pisoLote: '',
    precio: currentDolar * 100, // Equivale exactamente a 100 USD en pesos
    moneda: 'ARS',
    expensas: 0,
    dormitorios: 2,
    caracteristicas: 'Lindo departamento con patio',
    contacto: '123456789',
    zona: 'Yerba Buena',
    operacion: 'alquiler',
    tipo_propiedad: 'departamento',
    sheetName: 'Alquileres'
  };

  const request: ExtractedRealEstateRequest = {
    operacion: 'alquiler',
    tipo_propiedad: 'departamento',
    zonas: ['Yerba Buena'],
    presupuesto_max: 101, // Presupuesto de 101 USD (la propiedad cuesta 100 USD al cambio)
    moneda: 'USD',
    dormitorios: 2,
    caracteristicas_clave: [],
    country: 'indiferente'
  };

  const result = checkMatch(request, property);
  assert.ok(result.isMatch, 'La propiedad debió matchear ya que entra en el presupuesto convertido.');

  // Ahora bajamos el presupuesto a 90 USD (la propiedad cuesta 100 USD, debería fallar)
  request.presupuesto_max = 90;
  const resultFailed = checkMatch(request, property);
  assert.ok(!resultFailed.isMatch, 'La propiedad no debió matchear ya que excede el presupuesto.');
});
