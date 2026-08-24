import test from 'node:test';
import assert from 'node:assert';
import { createRateLimiter, createDistributedRateLimiter } from '../src/utils/rateLimit';

// KAN-127: mock mínimo de un cliente Supabase — mismo patrón que tests/zonesService.test.ts.
// Simula la tabla `rate_limit_counters` en memoria dentro del propio test (no pega a la red),
// reproduciendo la semántica atómica real de la función `rate_limit_check` (ver la migración
// create_rate_limit_counters_table): si la ventana venció, resetea a 1; si no, incrementa.
function makeMockRateLimitClient() {
  const counters = new Map<string, { count: number; resetAt: number }>();
  const calls: { key: string; maxRequests: number; windowMs: number }[] = [];

  return {
    counters,
    calls,
    rpc: (fn: string, params: { p_key: string; p_max_requests: number; p_window_ms: number }) => {
      if (fn !== 'rate_limit_check') {
        return Promise.resolve({ data: null, error: { message: `RPC inesperada: ${fn}` } });
      }
      calls.push({ key: params.p_key, maxRequests: params.p_max_requests, windowMs: params.p_window_ms });

      const now = Date.now();
      const entry = counters.get(params.p_key);
      let count: number;
      if (!entry || entry.resetAt <= now) {
        count = 1;
        counters.set(params.p_key, { count, resetAt: now + params.p_window_ms });
      } else {
        count = entry.count + 1;
        counters.set(params.p_key, { count, resetAt: entry.resetAt });
      }

      return Promise.resolve({ data: count <= params.p_max_requests, error: null });
    }
  };
}

function makeErroringMockClient(errorMessage: string) {
  return {
    rpc: () => Promise.resolve({ data: null, error: { message: errorMessage } })
  };
}

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

// --- KAN-127: createDistributedRateLimiter (backend Postgres, cliente mockeado) ---

test('createDistributedRateLimiter - permite requests por debajo del límite', async () => {
  const client = makeMockRateLimitClient();
  const limiter = createDistributedRateLimiter('search', 3, 60_000, client as any);

  assert.strictEqual(await limiter.check('tenant-a'), true);
  assert.strictEqual(await limiter.check('tenant-a'), true);
  assert.strictEqual(await limiter.check('tenant-a'), true);
});

test('createDistributedRateLimiter - bloquea a partir del request que supera el límite dentro de la ventana', async () => {
  const client = makeMockRateLimitClient();
  const limiter = createDistributedRateLimiter('search', 3, 60_000, client as any);

  await limiter.check('tenant-a');
  await limiter.check('tenant-a');
  await limiter.check('tenant-a');

  assert.strictEqual(await limiter.check('tenant-a'), false, 'El 4to request dentro de la ventana debe bloquearse.');
});

test('createDistributedRateLimiter - las claves quedan prefijadas con el limiterId (no comparten contador entre limiters distintos)', async () => {
  const client = makeMockRateLimitClient();
  const searchLimiter = createDistributedRateLimiter('search', 1, 60_000, client as any);
  const uploadLimiter = createDistributedRateLimiter('upload', 1, 60_000, client as any);

  assert.strictEqual(await searchLimiter.check('tenant-a'), true);
  assert.strictEqual(await searchLimiter.check('tenant-a'), false, 'tenant-a ya agotó su cupo de "search".');
  assert.strictEqual(await uploadLimiter.check('tenant-a'), true, 'El mismo tenantId en el limiter de "upload" es un contador aparte.');

  assert.ok(client.calls.some((c) => c.key === 'search:tenant-a'));
  assert.ok(client.calls.some((c) => c.key === 'upload:tenant-a'));
});

test('createDistributedRateLimiter - las claves son independientes entre sí dentro del mismo limiter', async () => {
  const client = makeMockRateLimitClient();
  const limiter = createDistributedRateLimiter('search', 1, 60_000, client as any);

  assert.strictEqual(await limiter.check('tenant-a'), true);
  assert.strictEqual(await limiter.check('tenant-a'), false, 'tenant-a ya agotó su cupo.');
  assert.strictEqual(await limiter.check('tenant-b'), true, 'tenant-b no debe verse afectado por el cupo de tenant-a.');
});

test('createDistributedRateLimiter - se resetea después de que expira la ventana', async () => {
  const client = makeMockRateLimitClient();
  const limiter = createDistributedRateLimiter('search', 1, 30, client as any);

  assert.strictEqual(await limiter.check('tenant-a'), true);
  assert.strictEqual(await limiter.check('tenant-a'), false);

  await new Promise((r) => setTimeout(r, 40));

  assert.strictEqual(await limiter.check('tenant-a'), true, 'Después de expirar la ventana, debe permitir de nuevo.');
});

test('createDistributedRateLimiter - falla abierto (permite el request) si Postgres devuelve un error', async () => {
  const client = makeErroringMockClient('fallo de red simulado hacia Supabase');
  const limiter = createDistributedRateLimiter('search', 1, 60_000, client as any);

  assert.strictEqual(await limiter.check('tenant-a'), true, 'Ante un error de rate_limit_check, debe permitir el request (fail-open) en vez de bloquear.');
});

// --- KAN-131: rate limiting de GET /api/metrics (panel admin autenticado) ---
// Mismo patrón que las pruebas "simulated handler" de KAN-71 más arriba: sin supertest/harness de
// Express en este repo (ver tests/errorMessageLeak.test.ts), se replica el bloque real de
// src/adminRoutes.ts (condición + status + body) contra la función real createDistributedRateLimiter,
// para ejercitar la lógica real sin red ni servidor.

function simulateMetricsRateLimitedHandler(
  limiter: ReturnType<typeof createDistributedRateLimiter>,
  adminUserId: string
): Promise<SimulatedResponse> {
  return (async () => {
    if (!(await limiter.check(adminUserId))) {
      return { statusCode: 429, body: { error: 'Demasiadas solicitudes de métricas. Esperá un minuto e intentá de nuevo.' } };
    }
    return { statusCode: 200, body: { success: true } };
  })();
}

test('rateLimit (KAN-131) - GET /api/metrics responde 429 al superar el límite configurado (30/min) y 200 por debajo', async () => {
  const client = makeMockRateLimitClient();
  const limiter = createDistributedRateLimiter('admin-metrics', 30, 60_000, client as any);

  const respuestas: SimulatedResponse[] = [];
  for (let i = 0; i < 31; i++) {
    respuestas.push(await simulateMetricsRateLimitedHandler(limiter, 'admin-1'));
  }

  const primeras30 = respuestas.slice(0, 30);
  const trigesimaPrimera = respuestas[30];

  assert.ok(primeras30.every((r) => r.statusCode === 200), 'Las primeras 30 solicitudes de métricas del admin deben pasar.');
  assert.strictEqual(trigesimaPrimera.statusCode, 429, 'La solicitud número 31 dentro de la ventana debe ser rechazada.');
  assert.match((trigesimaPrimera.body as { error: string }).error, /Demasiadas solicitudes de métricas/);
});

test('rateLimit (KAN-131) - el rate limit de /api/metrics es por adminUserId: un admin bloqueado no afecta a otro admin', async () => {
  const client = makeMockRateLimitClient();
  const limiter = createDistributedRateLimiter('admin-metrics', 3, 60_000, client as any);

  for (let i = 0; i < 3; i++) await simulateMetricsRateLimitedHandler(limiter, 'admin-abusivo');

  const bloqueado = await simulateMetricsRateLimitedHandler(limiter, 'admin-abusivo');
  const otroAdmin = await simulateMetricsRateLimitedHandler(limiter, 'admin-legitimo');

  assert.strictEqual(bloqueado.statusCode, 429);
  assert.strictEqual(otroAdmin.statusCode, 200, 'Un admin distinto no debe verse afectado por el abuso de otro.');
});

test('rateLimit (KAN-131) - simula carga alta: ráfaga de 100 requests concurrentes de un mismo admin solo deja pasar el límite configurado', async () => {
  // Prueba funcional bajo alta concurrencia: dispara las 100 solicitudes en paralelo (Promise.all)
  // en vez de secuencialmente, para verificar que el conteo en Postgres (mockeado acá) sigue
  // siendo correcto incluso cuando las requests no llegan en orden estrictamente serializado —
  // el mock resuelve cada rpc() de forma síncrona internamente, así que no hay condición de
  // carrera real, pero sí ejercita el mismo camino de código que vería una ráfaga real.
  const client = makeMockRateLimitClient();
  const limiter = createDistributedRateLimiter('admin-metrics', 30, 60_000, client as any);

  const respuestas = await Promise.all(
    Array.from({ length: 100 }, () => simulateMetricsRateLimitedHandler(limiter, 'admin-bajo-carga'))
  );

  const permitidas = respuestas.filter((r) => r.statusCode === 200).length;
  const rechazadas = respuestas.filter((r) => r.statusCode === 429).length;

  assert.strictEqual(permitidas, 30, 'De 100 requests en ráfaga, solo las primeras 30 (el límite real) deben permitirse.');
  assert.strictEqual(rechazadas, 70, 'Las 70 restantes deben rechazarse con 429.');
});

test('createDistributedRateLimiter (KAN-127, AC1) - simula 3 instancias del proceso, sin estado en memoria compartido entre ellas, y el límite se respeta igual', async () => {
  // Cada "instancia" es un objeto RateLimiter completamente independiente (llamada separada a
  // createDistributedRateLimiter, sin compartir ningún Map local) — lo único que comparten es el
  // mismo cliente/tabla de Postgres, igual que 3 procesos Node reales detrás de un balanceador de
  // carga. Si el límite fuera en-memoria (createRateLimiter), cada instancia tendría su propio
  // cupo de 5 y el tenant podría hacer 15 requests en total; acá debe seguir viendo solo 5.
  const sharedClient = makeMockRateLimitClient();
  const instanceA = createDistributedRateLimiter('search', 5, 60_000, sharedClient as any);
  const instanceB = createDistributedRateLimiter('search', 5, 60_000, sharedClient as any);
  const instanceC = createDistributedRateLimiter('search', 5, 60_000, sharedClient as any);

  const resultados: boolean[] = [];
  const instancias = [instanceA, instanceB, instanceC];
  for (let i = 0; i < 15; i++) {
    const instancia = instancias[i % 3];
    resultados.push(await instancia.check('tenant-multi-instancia'));
  }

  const permitidos = resultados.filter((r) => r === true).length;
  const bloqueados = resultados.filter((r) => r === false).length;

  assert.strictEqual(permitidos, 5, 'De 15 requests repartidas entre 3 instancias, solo las primeras 5 (el límite real) deben permitirse.');
  assert.strictEqual(bloqueados, 10, 'Las 10 restantes deben bloquearse — el límite es compartido entre instancias, no 5 por instancia.');
});
