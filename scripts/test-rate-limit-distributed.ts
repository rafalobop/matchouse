// KAN-127: script de verificación manual del rate limiter distribuido (Postgres) contra la base
// real — prueba lo que un test con cliente mockeado no puede probar: que la función
// `rate_limit_check` (migración create_rate_limit_counters_table) serializa de verdad las
// llamadas concurrentes de múltiples "instancias" del proceso Node sin perder ni duplicar
// conteos, incluso bajo concurrencia real (Promise.all, no un loop secuencial).
//
// No es parte de `npm test` (requiere una conexión real a Supabase) — se corre manualmente con
// `ts-node scripts/test-rate-limit-distributed.ts`. Usa una key descartable (con timestamp) y la
// borra al final, corra como corra el resultado de los checks.

import { createDistributedRateLimiter } from '../src/utils/rateLimit';
import { supabase } from '../src/services/supabase';
import { assertDevOnly } from './utils/devOnlyGuard';

let failures = 0;
function check(condition: boolean, okMsg: string, failMsg: string) {
  if (condition) {
    console.log(`✅ ${okMsg}`);
  } else {
    failures++;
    console.error(`❌ ${failMsg}`);
  }
}

async function main() {
  assertDevOnly('test-rate-limit-distributed.ts');

  const testTenantId = `test-kan127-${Date.now()}`;
  const MAX_REQUESTS = 5;
  const WINDOW_MS = 60_000;

  // 3 "instancias" reales: 3 objetos RateLimiter completamente independientes (cada uno con su
  // propia llamada a createDistributedRateLimiter), sin ningún Map ni estado en memoria
  // compartido entre ellos — lo único que comparten es la misma tabla de Postgres, igual que 3
  // procesos Node reales corriendo detrás de un balanceador de carga.
  const instanceA = createDistributedRateLimiter('search', MAX_REQUESTS, WINDOW_MS);
  const instanceB = createDistributedRateLimiter('search', MAX_REQUESTS, WINDOW_MS);
  const instanceC = createDistributedRateLimiter('search', MAX_REQUESTS, WINDOW_MS);
  const instances = [instanceA, instanceB, instanceC];

  console.log(`\n=== KAN-127: rate limiter distribuido — key de prueba "${testTenantId}" ===\n`);

  // --- Prueba 1: consistencia secuencial (AC1, caso simple) ---
  const sequentialResults: boolean[] = [];
  for (let i = 0; i < 15; i++) {
    const instance = instances[i % 3];
    sequentialResults.push(await instance.check(testTenantId));
  }
  const sequentialAllowed = sequentialResults.filter((r) => r).length;
  check(
    sequentialAllowed === MAX_REQUESTS,
    `Secuencial: 15 requests repartidas round-robin entre 3 instancias → exactamente ${MAX_REQUESTS} permitidas (real).`,
    `Secuencial: se esperaban ${MAX_REQUESTS} permitidas, se permitieron ${sequentialAllowed}.`
  );

  // Limpiar antes de la prueba de concurrencia real, para no arrastrar el conteo de la prueba 1.
  await supabase.from('rate_limit_counters').delete().eq('key', `search:${testTenantId}`);

  // --- Prueba 2: concurrencia real (Promise.all) — el caso que de verdad puede exponer una
  // condición de carrera si el UPSERT de rate_limit_check no fuera atómico. ---
  const concurrentChecks = Array.from({ length: 15 }, (_, i) => instances[i % 3].check(testTenantId));
  const concurrentResults = await Promise.all(concurrentChecks);
  const concurrentAllowed = concurrentResults.filter((r) => r).length;
  check(
    concurrentAllowed === MAX_REQUESTS,
    `Concurrente (Promise.all): 15 requests simultáneas entre 3 instancias → exactamente ${MAX_REQUESTS} permitidas (sin condición de carrera).`,
    `Concurrente: se esperaban ${MAX_REQUESTS} permitidas, se permitieron ${concurrentAllowed} — posible condición de carrera en rate_limit_check.`
  );

  // --- Limpieza ---
  const { error: cleanupError } = await supabase
    .from('rate_limit_counters')
    .delete()
    .eq('key', `search:${testTenantId}`);
  check(!cleanupError, 'Limpieza: fila de prueba borrada de rate_limit_counters.', `Limpieza falló: ${cleanupError?.message}`);

  console.log(`\n=== Resultado: ${failures === 0 ? 'TODO OK' : `${failures} fallo(s)`} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Error inesperado corriendo la verificación:', err);
  process.exit(1);
});
