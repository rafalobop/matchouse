import test from 'node:test';
import assert from 'node:assert';
import { createRateLimiter } from '../src/utils/rateLimit';

test('rateLimit - permite requests por debajo del límite', () => {
  const limiter = createRateLimiter(3, 60_000);
  assert.strictEqual(limiter.check('tenant-a'), true);
  assert.strictEqual(limiter.check('tenant-a'), true);
  assert.strictEqual(limiter.check('tenant-a'), true);
});

test('rateLimit - bloquea a partir del request que supera el límite dentro de la ventana', () => {
  const limiter = createRateLimiter(3, 60_000);
  limiter.check('tenant-a');
  limiter.check('tenant-a');
  limiter.check('tenant-a');
  assert.strictEqual(limiter.check('tenant-a'), false, 'El 4to request dentro de la ventana debe bloquearse.');
  assert.strictEqual(limiter.check('tenant-a'), false, 'Sigue bloqueado mientras la ventana no expiró.');
});

test('rateLimit - las claves son independientes entre sí (no afecta el tráfico normal de otros tenants)', () => {
  const limiter = createRateLimiter(1, 60_000);
  assert.strictEqual(limiter.check('tenant-a'), true);
  assert.strictEqual(limiter.check('tenant-a'), false, 'tenant-a ya agotó su cupo.');
  assert.strictEqual(limiter.check('tenant-b'), true, 'tenant-b no debe verse afectado por el cupo de tenant-a.');
});

test('rateLimit - se resetea después de que expira la ventana', async () => {
  const limiter = createRateLimiter(1, 30);
  assert.strictEqual(limiter.check('tenant-a'), true);
  assert.strictEqual(limiter.check('tenant-a'), false);

  await new Promise((r) => setTimeout(r, 40));

  assert.strictEqual(limiter.check('tenant-a'), true, 'Después de expirar la ventana, debe permitir de nuevo.');
});

test('rateLimit - no afecta negativamente tráfico normal de bajo volumen (patrón de uso real de un usuario)', () => {
  // Simula un usuario real usando el formulario de búsqueda: unas pocas búsquedas espaciadas,
  // muy por debajo del límite configurado para /api/search (10/min, ver src/config/env.ts).
  const limiter = createRateLimiter(10, 60_000);
  const resultados = Array.from({ length: 4 }, () => limiter.check('tenant-normal'));
  assert.ok(resultados.every((r) => r === true), 'Un usuario con tráfico normal (4 búsquedas) nunca debe ser bloqueado.');
});

// --- KAN-71: simulación del bloque de rate limit real de cada endpoint (src/index.ts) ---
// Mismo patrón que tests/excel.test.ts (KAN-66): no se importa src/index.ts directamente
// (arranca el servidor completo al importarse), se replica el bloque real (condición + status +
// body) usando la misma función real createRateLimiter, para ejercitar la lógica real sin red.

interface SimulatedResponse {
  statusCode: number;
  body: { error: string } | { success: true };
}

function simulateSearchRateLimitedHandler(limiter: ReturnType<typeof createRateLimiter>, tenantId: string): SimulatedResponse {
  if (!limiter.check(tenantId)) {
    return { statusCode: 429, body: { error: 'Demasiadas búsquedas. Esperá un minuto e intentá de nuevo.' } };
  }
  return { statusCode: 200, body: { success: true } };
}

function simulateUploadRateLimitedHandler(limiter: ReturnType<typeof createRateLimiter>, tenantId: string): SimulatedResponse {
  if (!limiter.check(tenantId)) {
    return { statusCode: 429, body: { error: 'Demasiadas subidas de archivo. Esperá un minuto e intentá de nuevo.' } };
  }
  return { statusCode: 200, body: { success: true } };
}

test('rateLimit (KAN-71) - POST /api/search responde 429 al superar el límite configurado (10/min) y 200 por debajo', () => {
  const limiter = createRateLimiter(10, 60_000);
  const respuestas = Array.from({ length: 11 }, () => simulateSearchRateLimitedHandler(limiter, 'tenant-search'));

  const primeras10 = respuestas.slice(0, 10);
  const undecima = respuestas[10];

  assert.ok(primeras10.every((r) => r.statusCode === 200), 'Las primeras 10 búsquedas del tenant deben pasar.');
  assert.strictEqual(undecima.statusCode, 429, 'La búsqueda número 11 dentro de la ventana debe ser rechazada.');
  assert.match((undecima.body as { error: string }).error, /Demasiadas búsquedas/);
});

test('rateLimit (KAN-71) - POST /api/upload responde 429 al superar el límite configurado (5/min) y 200 por debajo', () => {
  const limiter = createRateLimiter(5, 60_000);
  const respuestas = Array.from({ length: 6 }, () => simulateUploadRateLimitedHandler(limiter, 'tenant-upload'));

  const primeras5 = respuestas.slice(0, 5);
  const sexta = respuestas[5];

  assert.ok(primeras5.every((r) => r.statusCode === 200), 'Las primeras 5 subidas del tenant deben pasar.');
  assert.strictEqual(sexta.statusCode, 429, 'La subida número 6 dentro de la ventana debe ser rechazada.');
  assert.match((sexta.body as { error: string }).error, /Demasiadas subidas/);
});

test('rateLimit (KAN-71) - el rate limit es por tenant: un tenant bloqueado no afecta a otro tenant en el mismo endpoint', () => {
  const limiter = createRateLimiter(5, 60_000);
  for (let i = 0; i < 5; i++) simulateUploadRateLimitedHandler(limiter, 'tenant-abusivo');

  const bloqueado = simulateUploadRateLimitedHandler(limiter, 'tenant-abusivo');
  const otroTenant = simulateUploadRateLimitedHandler(limiter, 'tenant-legitimo');

  assert.strictEqual(bloqueado.statusCode, 429);
  assert.strictEqual(otroTenant.statusCode, 200, 'Un tenant distinto no debe verse afectado por el abuso de otro.');
});
