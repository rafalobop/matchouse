import test from 'node:test';
import assert from 'node:assert';
import {
  runLicenseValidationRetry,
  startLicenseValidationRetryService,
  stopLicenseValidationRetryService
} from '../src/services/licenseValidationRetry';

// KAN-306: runLicenseValidationRetry hace 3 cosas por corrida — (1) syncLicensedAgents (pega a la
// red real vía fetch nativo, sin seam de inyección en esta función; se cubre por separado en
// licenseRegistry.test.ts), (2) lee profiles.pending, (3) resuelve cada una contra
// `licensed_agents` y persiste. Acá se mockea el cliente completo (profiles + licensed_agents) —
// syncLicensedAgents va a fallar contra la red real en este entorno de test (sin conexión
// controlada) y eso es aceptable: es fail-safe por diseño (loguea y sigue), así que
// licensed_agents queda vacía y resolveLicenseValidationStatus cae a 'pending' salvo que el mock
// de licensed_agents le gane esa carrera. Para no depender de esa carrera, el mock de
// `licensed_agents` siempre responde con datos ya "frescos" controlados por el test.

function makeMockClient(options: {
  pendingProfiles?: { id: string; license_number: string }[];
  pendingError?: any;
  matchedLicenseNumbers?: string[];
  updateError?: any;
}) {
  const calls: { table: string; method: string; args: any[] }[] = [];
  const freshDate = new Date().toISOString();

  return {
    from: (table: string) => {
      if (table === 'profiles') {
        const builder: any = {
          select: (...args: any[]) => { calls.push({ table, method: 'select', args }); return builder; },
          eq: (...args: any[]) => { calls.push({ table, method: 'eq', args }); return builder; },
          not: (...args: any[]) => {
            calls.push({ table, method: 'not', args });
            return Promise.resolve({ data: options.pendingProfiles ?? [], error: options.pendingError ?? null });
          },
          update: (...args: any[]) => {
            calls.push({ table, method: 'update', args });
            return {
              eq: () => Promise.resolve({ error: options.updateError ?? null })
            };
          }
        };
        return builder;
      }
      if (table === 'licensed_agents') {
        return {
          upsert: () => Promise.resolve({ error: null }),
          delete: () => ({ lt: () => Promise.resolve({ error: null }) }),
          select: () => {
            const freshestBuilder: any = {
              order: () => freshestBuilder,
              limit: () => freshestBuilder,
              maybeSingle: () => Promise.resolve({ data: { synced_at: freshDate }, error: null }),
              eq: (_col: string, value: string) => ({
                maybeSingle: () => Promise.resolve({
                  data: (options.matchedLicenseNumbers ?? []).includes(value) ? { license_number: value } : null,
                  error: null
                })
              })
            };
            return freshestBuilder;
          }
        };
      }
      throw new Error(`tabla inesperada en el mock: ${table}`);
    },
    calls
  };
}

test('licenseValidationRetry - expone las funciones esperadas', () => {
  assert.strictEqual(typeof runLicenseValidationRetry, 'function');
  assert.strictEqual(typeof startLicenseValidationRetryService, 'function');
  assert.strictEqual(typeof stopLicenseValidationRetryService, 'function');
});

test('licenseValidationRetry - sin perfiles pendientes, devuelve listas vacías', async () => {
  const client = makeMockClient({ pendingProfiles: [] });
  const result = await runLicenseValidationRetry(client as any);
  assert.deepStrictEqual(result, { validated: [], rejected: [] });
});

test('licenseValidationRetry - promueve a validated cuando la matrícula matchea contra la caché fresca', async () => {
  const client = makeMockClient({
    pendingProfiles: [{ id: 'tenant-a', license_number: '001' }],
    matchedLicenseNumbers: ['001']
  });
  const result = await runLicenseValidationRetry(client as any);
  assert.deepStrictEqual(result, { validated: ['tenant-a'], rejected: [] });
});

test('licenseValidationRetry - pasa a rejected cuando la matrícula no matchea contra la caché fresca', async () => {
  const client = makeMockClient({
    pendingProfiles: [{ id: 'tenant-b', license_number: '999999' }],
    matchedLicenseNumbers: []
  });
  const result = await runLicenseValidationRetry(client as any);
  assert.deepStrictEqual(result, { validated: [], rejected: ['tenant-b'] });
});

test('licenseValidationRetry - propaga el error si falla la lectura de perfiles pendientes', async () => {
  const client = makeMockClient({ pendingError: { message: 'fallo simulado' } });
  await assert.rejects(() => runLicenseValidationRetry(client as any));
});

test('licenseValidationRetry - start/stop no lanzan y dejan un timer detenible', () => {
  startLicenseValidationRetryService();
  stopLicenseValidationRetryService();
  assert.ok(true, 'startLicenseValidationRetryService/stopLicenseValidationRetryService deben poder llamarse sin lanzar.');
});
