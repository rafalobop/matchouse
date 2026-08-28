import test from 'node:test';
import assert from 'node:assert';
import { processSingleSearchSegment } from '../src/services/searchSegmentProcessor';
import * as aiService from '../src/services/ai';
import * as blindMatchingService from '../src/services/blindMatching';
import * as notificationsService from '../src/services/notifications';
import * as realtimeHubService from '../src/services/realtimeHub';

const DEFAULT_EXTRACTED_DATA = {
  operation: 'venta' as const,
  property_type: 'casa' as const,
  zones: [],
  max_budget: 100000,
  currency: 'USD' as const,
  bedrooms: 2,
  key_features: [],
  country: 'indiferente' as const
};

const DEFAULT_ZONE_INTENT = {
  zone_status: 'INDEFINIDA' as const,
  zona_ids: [] as string[],
  zona_nombres: [] as string[],
  texto_ubicacion_original: '',
  dormitorios_min: null,
  caracteristicas_claves: [] as string[],
  operacion: 'DESCONOCIDO' as const
};

const DEFAULT_SEARCH_ROW = {
  id: 'search-1',
  criteria: DEFAULT_EXTRACTED_DATA,
  zone_status: 'INDEFINIDA',
  zone_names: [] as string[],
  created_at: '2026-08-24T00:00:00.000Z',
  expires_at: '2026-08-31T00:00:00.000Z'
};

const DEFAULT_PROFILE_ROW = {
  full_name: 'Juan Perez',
  phone_number: '5493815551234',
  agency_name: 'Inmobiliaria Test',
  email: 'juan.perez@example.com'
};

function sampleProperty(overrides: Partial<any> = {}) {
  return {
    address: 'Calle Falsa 123',
    price: 100000,
    currency: 'USD',
    bedrooms: 2,
    property_type: 'casa',
    operation: 'venta',
    ...overrides
  };
}

function sampleMatch(overrides: Partial<any> = {}) {
  return {
    tenant_id: 'tenant-owner-1',
    property: sampleProperty(),
    score: 0.9,
    reasons: ['zona', 'presupuesto'],
    ...overrides
  };
}

// Mock de cliente Supabase scoped al tenant que cubre las tres tablas que toca
// processSingleSearchSegment directamente: active_searches (insert de la búsqueda), profiles
// (snapshot del propio buscador) y blind_matches (insert de los matches encontrados). Las
// dependencias externas (IA, matching cross-tenant, notificaciones, WS) se mockean aparte vía
// t.mock.method sobre los módulos correspondientes — mismo patrón que graph-integration.test.ts.
function makeTenantSupabaseMock(options: {
  searchInsertError?: any;
  searchRow?: any;
  profileRow?: any;
  profileError?: any;
  matchInsertError?: any;
  matchInsertIds?: string[];
} = {}) {
  const calls: { table: string; method: string; args: any[] }[] = [];

  function activeSearchesBuilder() {
    const builder: any = {
      insert: (row: any) => { calls.push({ table: 'active_searches', method: 'insert', args: [row] }); return builder; },
      select: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'select', args }); return builder; },
      single: () => Promise.resolve(
        options.searchInsertError
          ? { data: null, error: options.searchInsertError }
          : { data: options.searchRow ?? DEFAULT_SEARCH_ROW, error: null }
      )
    };
    return builder;
  }

  function profilesBuilder() {
    const builder: any = {
      select: (...args: any[]) => { calls.push({ table: 'profiles', method: 'select', args }); return builder; },
      eq: (...args: any[]) => { calls.push({ table: 'profiles', method: 'eq', args }); return builder; },
      single: () => Promise.resolve(
        options.profileError
          ? { data: null, error: options.profileError }
          : { data: options.profileRow ?? DEFAULT_PROFILE_ROW, error: null }
      )
    };
    return builder;
  }

  function blindMatchesBuilder() {
    return {
      insert: (rows: any[]) => {
        calls.push({ table: 'blind_matches', method: 'insert', args: [rows] });
        return {
          select: (cols: string) => {
            calls.push({ table: 'blind_matches', method: 'select', args: [cols] });
            if (options.matchInsertError) return Promise.resolve({ data: null, error: options.matchInsertError });
            const ids = options.matchInsertIds ?? rows.map((_: any, i: number) => `match-${i + 1}`);
            return Promise.resolve({ data: ids.map((id) => ({ id })), error: null });
          }
        };
      }
    };
  }

  return {
    from: (table: string) => {
      if (table === 'active_searches') return activeSearchesBuilder();
      if (table === 'profiles') return profilesBuilder();
      if (table === 'blind_matches') return blindMatchesBuilder();
      throw new Error(`Tabla no mockeada en este test: ${table}`);
    },
    calls
  };
}

test('processSingleSearchSegment - operation "desconocido" devuelve error sin tocar DB ni zona/matching', async (t) => {
  t.mock.method(aiService, 'extractFromTextInput', async () => ({ ...DEFAULT_EXTRACTED_DATA, operation: 'desconocido' }));
  const extractZoneMock = t.mock.method(aiService, 'extractZoneIntent', async () => DEFAULT_ZONE_INTENT);
  const findMatchesMock = t.mock.method(blindMatchingService, 'findCrossTenantMatches', async () => []);
  const tenantSupabase = makeTenantSupabaseMock();

  const result = await processSingleSearchSegment('tenant-1', tenantSupabase as any, 'texto sin clasificar');

  assert.strictEqual(result.success, false);
  assert.ok(result.error);
  assert.strictEqual(extractZoneMock.mock.callCount(), 0, 'No debe resolver zona si ni siquiera se clasificó la operación.');
  assert.strictEqual(findMatchesMock.mock.callCount(), 0);
  assert.strictEqual(tenantSupabase.calls.length, 0, 'No debe insertar nada en active_searches.');
});

test('processSingleSearchSegment - sin matches cross-tenant, no toca profiles/blind_matches ni notifica', async (t) => {
  t.mock.method(aiService, 'extractFromTextInput', async () => DEFAULT_EXTRACTED_DATA);
  t.mock.method(aiService, 'extractZoneIntent', async () => DEFAULT_ZONE_INTENT);
  t.mock.method(blindMatchingService, 'findCrossTenantMatches', async () => []);
  const notifyMock = t.mock.method(notificationsService, 'notifyMatchFound', async () => 'push' as const);
  const broadcastMock = t.mock.method(realtimeHubService, 'broadcastMatchCountChanged', () => {});
  const tenantSupabase = makeTenantSupabaseMock();

  const result = await processSingleSearchSegment('tenant-1', tenantSupabase as any, 'busco casa');

  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(result.matches, []);
  assert.ok(!tenantSupabase.calls.some(c => c.table === 'profiles'));
  assert.ok(!tenantSupabase.calls.some(c => c.table === 'blind_matches'));
  assert.strictEqual(notifyMock.mock.callCount(), 0);
  assert.strictEqual(broadcastMock.mock.callCount(), 0);
});

test('processSingleSearchSegment - un match nuevo se persiste, notifica en ambas direcciones y devuelve el id insertado', async (t) => {
  t.mock.method(aiService, 'extractFromTextInput', async () => DEFAULT_EXTRACTED_DATA);
  t.mock.method(aiService, 'extractZoneIntent', async () => DEFAULT_ZONE_INTENT);
  t.mock.method(blindMatchingService, 'findCrossTenantMatches', async () => [sampleMatch()]);
  const notifyMock = t.mock.method(notificationsService, 'notifyMatchFound', async () => 'push' as const);
  const broadcastMock = t.mock.method(realtimeHubService, 'broadcastMatchCountChanged', () => {});
  const tenantSupabase = makeTenantSupabaseMock({ matchInsertIds: ['match-1'] });

  const result = await processSingleSearchSegment('tenant-searcher', tenantSupabase as any, 'busco casa en venta');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.search?.id, 'search-1');
  assert.strictEqual(result.matches?.length, 1);
  assert.strictEqual(result.matches?.[0].id, 'match-1');
  assert.strictEqual(result.matches?.[0].tenant_id, 'tenant-owner-1');

  const insertCall = tenantSupabase.calls.find(c => c.table === 'blind_matches' && c.method === 'insert');
  assert.ok(insertCall, 'Debe insertar una fila en blind_matches.');
  assert.strictEqual(insertCall!.args[0][0].tenant_id, 'tenant-searcher');
  assert.strictEqual(insertCall!.args[0][0].matched_tenant_id, 'tenant-owner-1');

  // Decisión de producto (2026-08-21): el buscador ya no se notifica de los matches de su propia
  // búsqueda, solo el dueño de la propiedad matcheada (KAN-304).
  assert.strictEqual(notifyMock.mock.callCount(), 1);
  assert.strictEqual(broadcastMock.mock.callCount(), 1);
  assert.deepStrictEqual(broadcastMock.mock.calls[0].arguments[0], ['tenant-searcher', 'tenant-owner-1']);
});

test('processSingleSearchSegment - matches de varios dueños agrupa y notifica una vez por dueño único', async (t) => {
  t.mock.method(aiService, 'extractFromTextInput', async () => DEFAULT_EXTRACTED_DATA);
  t.mock.method(aiService, 'extractZoneIntent', async () => DEFAULT_ZONE_INTENT);
  t.mock.method(blindMatchingService, 'findCrossTenantMatches', async () => [
    sampleMatch({ tenant_id: 'tenant-owner-a' }),
    sampleMatch({ tenant_id: 'tenant-owner-b' }),
    sampleMatch({ tenant_id: 'tenant-owner-a' }) // dos matches del mismo dueño
  ]);
  const notifyMock = t.mock.method(notificationsService, 'notifyMatchFound', async () => 'push' as const);
  const broadcastMock = t.mock.method(realtimeHubService, 'broadcastMatchCountChanged', () => {});
  const tenantSupabase = makeTenantSupabaseMock();

  const result = await processSingleSearchSegment('tenant-searcher', tenantSupabase as any, 'busco casa en venta');

  assert.strictEqual(result.matches?.length, 3);
  // 1 aviso por cada dueño único (a y b), no uno por match ni uno al buscador (KAN-304).
  assert.strictEqual(notifyMock.mock.callCount(), 2);
  assert.deepStrictEqual(broadcastMock.mock.calls[0].arguments[0], ['tenant-searcher', 'tenant-owner-a', 'tenant-owner-b']);
});

test('processSingleSearchSegment - si falla el insert de active_searches, propaga el error y no sigue al matching', async (t) => {
  t.mock.method(aiService, 'extractFromTextInput', async () => DEFAULT_EXTRACTED_DATA);
  t.mock.method(aiService, 'extractZoneIntent', async () => DEFAULT_ZONE_INTENT);
  const findMatchesMock = t.mock.method(blindMatchingService, 'findCrossTenantMatches', async () => [sampleMatch()]);
  const tenantSupabase = makeTenantSupabaseMock({ searchInsertError: { message: 'fallo simulado de insert' } });

  // insertErr se relanza tal cual (objeto plano de error de Supabase, no un Error real) — ver
  // "if (insertErr) throw insertErr;" en el código fuente.
  await assert.rejects(
    () => processSingleSearchSegment('tenant-1', tenantSupabase as any, 'busco casa'),
    (err: any) => err.message === 'fallo simulado de insert'
  );
  assert.strictEqual(findMatchesMock.mock.callCount(), 0);
});

test('processSingleSearchSegment - si falla la persistencia de blind_matches (best-effort), igual devuelve éxito y notifica', async (t) => {
  t.mock.method(aiService, 'extractFromTextInput', async () => DEFAULT_EXTRACTED_DATA);
  t.mock.method(aiService, 'extractZoneIntent', async () => DEFAULT_ZONE_INTENT);
  t.mock.method(blindMatchingService, 'findCrossTenantMatches', async () => [sampleMatch()]);
  const notifyMock = t.mock.method(notificationsService, 'notifyMatchFound', async () => 'push' as const);
  t.mock.method(realtimeHubService, 'broadcastMatchCountChanged', () => {});
  // El perfil propio falla al leerse -> se corta antes del insert en blind_matches, pero la
  // búsqueda ya calculada no debe fallar por esto (comentario "Best-effort" en el código fuente).
  const tenantSupabase = makeTenantSupabaseMock({ profileError: { message: 'fallo simulado de perfil' } });

  const result = await processSingleSearchSegment('tenant-1', tenantSupabase as any, 'busco casa');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.matches?.[0].id, null);
  assert.ok(!tenantSupabase.calls.some(c => c.table === 'blind_matches'), 'No debe intentar insertar si no pudo armar el snapshot del buscador.');
  assert.strictEqual(notifyMock.mock.callCount(), 1, 'La notificación no depende de que la persistencia haya funcionado.');
});
