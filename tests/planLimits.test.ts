import test from 'node:test';
import assert from 'node:assert';
import {
  getTenantPlanLimits,
  countTenantProperties,
  countTenantSearchesThisMonth
} from '../src/services/planLimits';
import { PLAN_LIMITS } from '../src/config/planLimits';

// Fase 1 pre-lanzamiento: mock mínimo del builder encadenable de Supabase, mismo patrón que
// tests/excel.test.ts/tests/searchSegmentProcessor.test.ts. Cada tabla mockeada registra sus
// llamadas para poder assertear el filtro real mandado (tenant_id, created_at).
function makeSupabaseMock(options: {
  profileRow?: { plan: string } | null;
  profileError?: any;
  propertiesCount?: number;
  propertiesError?: any;
  searchesCount?: number;
  searchesError?: any;
}) {
  const calls: { table: string; method: string; args: any[] }[] = [];

  return {
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: (...args: any[]) => {
            calls.push({ table, method: 'select', args });
            return {
              eq: (...eqArgs: any[]) => {
                calls.push({ table, method: 'eq', args: eqArgs });
                return {
                  single: () => Promise.resolve(
                    options.profileError
                      ? { data: null, error: options.profileError }
                      : { data: options.profileRow ?? { plan: 'FREE' }, error: null }
                  )
                };
              }
            };
          }
        };
      }
      if (table === 'properties') {
        return {
          select: (...args: any[]) => {
            calls.push({ table, method: 'select', args });
            return {
              eq: (...eqArgs: any[]) => {
                calls.push({ table, method: 'eq', args: eqArgs });
                return Promise.resolve(
                  options.propertiesError
                    ? { count: null, error: options.propertiesError }
                    : { count: options.propertiesCount ?? 0, error: null }
                );
              }
            };
          }
        };
      }
      if (table === 'active_searches') {
        return {
          select: (...args: any[]) => {
            calls.push({ table, method: 'select', args });
            return {
              eq: (...eqArgs: any[]) => {
                calls.push({ table, method: 'eq', args: eqArgs });
                return {
                  gte: (...gteArgs: any[]) => {
                    calls.push({ table, method: 'gte', args: gteArgs });
                    return Promise.resolve(
                      options.searchesError
                        ? { count: null, error: options.searchesError }
                        : { count: options.searchesCount ?? 0, error: null }
                    );
                  }
                };
              }
            };
          }
        };
      }
      throw new Error(`Tabla no mockeada en este test: ${table}`);
    },
    calls
  };
}

test('getTenantPlanLimits - devuelve los límites del plan FREE leyendo profiles.plan', async () => {
  const supabase = makeSupabaseMock({ profileRow: { plan: 'FREE' } });

  const limits = await getTenantPlanLimits('tenant-1', supabase as any);

  assert.deepStrictEqual(limits, PLAN_LIMITS.FREE);
  assert.ok(supabase.calls.some((c) => c.table === 'profiles' && c.method === 'eq' && c.args[0] === 'id' && c.args[1] === 'tenant-1'));
});

test('getTenantPlanLimits - propaga el error de Supabase si falla la lectura del perfil', async () => {
  const supabase = makeSupabaseMock({ profileError: new Error('boom') });

  await assert.rejects(() => getTenantPlanLimits('tenant-1', supabase as any), /boom/);
});

test('getTenantPlanLimits - lanza un error explícito y claro si el plan no está en PLAN_LIMITS (KAN-341)', async () => {
  const supabase = makeSupabaseMock({ profileRow: { plan: 'ENTERPRISE_NO_EXISTE' } });

  await assert.rejects(
    () => getTenantPlanLimits('tenant-1', supabase as any),
    /Plan no reconocido.*ENTERPRISE_NO_EXISTE.*tenant-1/
  );
});

test('countTenantProperties - cuenta filtrando por tenant_id', async () => {
  const supabase = makeSupabaseMock({ propertiesCount: 42 });

  const count = await countTenantProperties('tenant-1', supabase as any);

  assert.strictEqual(count, 42);
  assert.ok(supabase.calls.some((c) => c.table === 'properties' && c.method === 'eq' && c.args[0] === 'tenant_id' && c.args[1] === 'tenant-1'));
});

test('countTenantProperties - devuelve 0 si count viene null', async () => {
  const supabase = makeSupabaseMock({ propertiesCount: undefined as any });
  // count:null es lo que devuelve PostgREST cuando la tabla está vacía para ese filtro.
  (supabase as any).from = () => ({
    select: () => ({ eq: () => Promise.resolve({ count: null, error: null }) })
  });

  const count = await countTenantProperties('tenant-1', supabase as any);

  assert.strictEqual(count, 0);
});

test('countTenantSearchesThisMonth - filtra por tenant_id y por created_at >= primer día del mes UTC en curso', async () => {
  const supabase = makeSupabaseMock({ searchesCount: 7 });

  const count = await countTenantSearchesThisMonth('tenant-1', supabase as any);

  assert.strictEqual(count, 7);
  const gteCall = supabase.calls.find((c) => c.table === 'active_searches' && c.method === 'gte');
  assert.ok(gteCall, 'Debe filtrar por created_at con .gte().');
  assert.strictEqual(gteCall!.args[0], 'created_at');

  const now = new Date();
  const expectedStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  assert.strictEqual(gteCall!.args[1], expectedStart);
});

test('countTenantSearchesThisMonth - propaga el error de Supabase', async () => {
  const supabase = makeSupabaseMock({ searchesError: new Error('boom') });

  await assert.rejects(() => countTenantSearchesThisMonth('tenant-1', supabase as any), /boom/);
});
