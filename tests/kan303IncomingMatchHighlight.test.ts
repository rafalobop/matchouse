import test from 'node:test';
import assert from 'node:assert';
import { processPropertyUploaded } from '../src/services/propertyMatchWebhook';
import { processSingleSearchSegment } from '../src/services/searchSegmentProcessor';
import { mapIncomingMatchRowToDashboardShape } from '../src/utils/blindMatchPersistence';
import * as webPushService from '../src/services/webPush';
import * as notifierEmailService from '../src/services/notifier-email';
import * as aiService from '../src/services/ai';
import * as blindMatchingService from '../src/services/blindMatching';
import * as realtimeHubService from '../src/services/realtimeHub';

// KAN-303: a diferencia de tests/propertyMatchWebhook.test.ts y tests/searchSegmentProcessor.test.ts
// (que mockean notifyMatchFound directamente y nunca llegan a construir el payload real), esta
// suite deja correr la cadena completa hasta buildIncomingMatchPushPayload de verdad — el objetivo
// es probar el contrato de punta a punta: el id que blind_matches genera al insertar es el mismo
// id que termina en `data.url` del push (?highlight=...) y el mismo que expone
// GET /api/matches/incoming (mapIncomingMatchRowToDashboardShape) para que buildIncomingMatchItem
// (src/dashboard/app.js) pueda encontrar la fila con data-match-id y resaltarla. Solo se mockean
// los bordes de I/O real (envío de push/email, Supabase/IA) — nunca la lógica de negocio en el medio.

// processPropertyUploaded/processSingleSearchSegment disparan notifyMatchFound() sin awaitearlo
// (fire-and-forget deliberado, ver comentario "no afecta el match ya persistido" en ambos
// services) — así que tras awaitear la función bajo test todavía puede haber una notificación en
// vuelo. Un macrotask (setTimeout) alcanza para drenar la cadena de promises interna
// (hasActivePush -> sendWithRetry -> action) antes de aserter sobre los mocks de envío.
function flushPendingNotification(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// ==========================================
// Dirección cartera→búsqueda (KAN-79, propertyMatchWebhook.ts)
// ==========================================

const PROPERTY_ROW = {
  id: 'prop-302',
  tenant_id: 'tenant-owner',
  address: 'Av. Siempre Viva 742',
  price: 150000,
  currency: 'USD',
  bedrooms: 3,
  operation: 'venta',
  property_type: 'casa',
  sheet_name: 'Ventas'
};

function sampleSearchRow(overrides: Partial<any> = {}) {
  return {
    id: 'search-302',
    tenant_id: 'tenant-searcher',
    raw_text: 'busco casa en venta',
    criteria: {
      operation: 'venta',
      property_type: 'casa',
      zones: [],
      max_budget: null,
      currency: 'desconocido',
      bedrooms: null,
      key_features: [],
      country: 'indiferente'
    },
    ...overrides
  };
}

// Mismo mock de cliente que tests/propertyMatchWebhook.test.ts, con una diferencia clave: acá
// web_push_subscriptions SÍ tiene una suscripción activa (count: 1), para forzar la rama de push
// real (no el fallback de email) — es la rama que arma la URL con highlight.
function makePropertyWebhookMockClient(options: {
  searchRows?: any[];
  insertedMatchId?: string;
} = {}) {
  function propertiesBuilder() {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      single: () => Promise.resolve({ data: PROPERTY_ROW, error: null })
    };
    return builder;
  }

  function activeSearchesBuilder() {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      or: () => builder,
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: options.searchRows ?? [], error: null }).then(resolve, reject)
    };
    return builder;
  }

  function blindMatchesBuilder() {
    return {
      select: () => ({
        eq: function (this: any) { return this; },
        then: (resolve: any) => resolve({ count: 0, error: null })
      }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: options.insertedMatchId ?? 'blind-match-302' }, error: null })
        })
      })
    };
  }

  function profilesBuilder() {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      single: () => Promise.resolve({
        data: { full_name: 'Juan Perez', phone_number: '5493815551234', agency_name: 'Inmobiliaria Test', email: 'juan@example.com' },
        error: null
      })
    };
    return builder;
  }

  function webPushSubscriptionsBuilder() {
    return {
      select: () => ({
        eq: () => Promise.resolve({ count: 1, error: null }) // suscripción activa -> rama de push
      })
    };
  }

  return {
    from: (table: string) => {
      if (table === 'properties') return propertiesBuilder();
      if (table === 'active_searches') return activeSearchesBuilder();
      if (table === 'blind_matches') return blindMatchesBuilder();
      if (table === 'profiles') return profilesBuilder();
      if (table === 'web_push_subscriptions') return webPushSubscriptionsBuilder();
      throw new Error(`Tabla no mockeada en este test: ${table}`);
    }
  };
}

test('KAN-303 integración (cartera→búsqueda) - el id insertado en blind_matches viaja intacto hasta ?highlight= del push real', async (t) => {
  const mockClient = makePropertyWebhookMockClient({
    searchRows: [sampleSearchRow()],
    insertedMatchId: 'blind-match-abc123'
  });

  // Único borde de I/O real que hace falta mockear en esta dirección: sendWebPushToTenant
  // siempre usa el singleton real de Supabase (no el cliente inyectado), así que sin este mock
  // el test intentaría pegarle a la infra real de web-push. buildIncomingMatchPushPayload NO se
  // mockea — es justo lo que este test quiere ejercitar de verdad.
  const sendPushMock = t.mock.method(webPushService, 'sendWebPushToTenant', async () => true);
  const emailFallbackMock = t.mock.method(notifierEmailService, 'sendIncomingMatchEmailFallback', async () => true);

  const result = await processPropertyUploaded('prop-302', mockClient as any);
  await flushPendingNotification();

  assert.strictEqual(result.matchesInserted, 1);

  assert.strictEqual(sendPushMock.mock.callCount(), 1, 'Debe usar el canal de push (hay suscripción activa), no el fallback de email.');
  assert.strictEqual(emailFallbackMock.mock.callCount(), 0, 'No debe duplicar el aviso por email si el push ya se mandó.');

  const [tenantIdArg, payloadArg] = sendPushMock.mock.calls[0].arguments as [string, Record<string, unknown>];
  assert.strictEqual(tenantIdArg, 'tenant-owner', 'El push debe ir al dueño de la propiedad nueva, no al buscador.');
  assert.strictEqual((payloadArg.data as any).url, '/matches?highlight=blind-match-abc123');
  assert.strictEqual(payloadArg.tag, 'incoming-match-blind-match-abc123');

  // Contrato con el frontend: el mismo id que el push usa para el highlight es el que
  // GET /api/matches/incoming expone como `id` (buildIncomingMatchItem lo usa como data-match-id).
  const dashboardShape = mapIncomingMatchRowToDashboardShape({ id: 'blind-match-abc123', created_at: new Date().toISOString(), raw_search_text: 'x', searcher_snapshot: {}, property_snapshot: {}, reasons: [], score: 90 });
  assert.strictEqual(dashboardShape.id, 'blind-match-abc123');
});

test('KAN-303 integración (cartera→búsqueda) - sin suscripción push activa, no arma el payload de push (usa email, sin highlight)', async (t) => {
  const mockClient = makePropertyWebhookMockClient({ searchRows: [sampleSearchRow()] });
  // Pisa el mock de arriba para simular 0 suscripciones activas.
  const originalFrom = mockClient.from;
  (mockClient as any).from = (table: string) => {
    if (table === 'web_push_subscriptions') return { select: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) };
    return originalFrom(table);
  };

  const sendPushMock = t.mock.method(webPushService, 'sendWebPushToTenant', async () => true);
  const emailFallbackMock = t.mock.method(notifierEmailService, 'sendIncomingMatchEmailFallback', async () => true);

  await processPropertyUploaded('prop-302', mockClient as any);
  await flushPendingNotification();

  assert.strictEqual(sendPushMock.mock.callCount(), 0, 'Sin suscripción activa no debe intentar push (buildIncomingMatchPushPayload nunca se llama).');
  assert.strictEqual(emailFallbackMock.mock.callCount(), 1, 'Debe caer al fallback de email.');
});

// ==========================================
// Dirección búsqueda→cartera (KAN-78, searchSegmentProcessor.ts)
// ==========================================

const DEFAULT_EXTRACTED_DATA = {
  operation: 'venta' as const,
  property_type: 'casa' as const,
  zones: [],
  max_budget: 150000,
  currency: 'USD' as const,
  bedrooms: 3,
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

function sampleProperty(overrides: Partial<any> = {}) {
  return { address: 'Calle Falsa 123', price: 150000, currency: 'USD', bedrooms: 3, property_type: 'casa', operation: 'venta', ...overrides };
}

function sampleMatch(overrides: Partial<any> = {}) {
  return { tenant_id: 'tenant-owner-302', property: sampleProperty(), score: 0.92, reasons: ['zona', 'presupuesto'], ...overrides };
}

function makeSearchSegmentTenantSupabaseMock(matchInsertIds: string[]) {
  const searchRow = { id: 'search-999', criteria: DEFAULT_EXTRACTED_DATA, zone_status: 'INDEFINIDA', zone_names: [] as string[], created_at: '2026-08-26T00:00:00.000Z', expires_at: '2026-09-02T00:00:00.000Z' };

  function activeSearchesBuilder() {
    const builder: any = {
      insert: () => builder,
      select: () => builder,
      single: () => Promise.resolve({ data: searchRow, error: null })
    };
    return builder;
  }

  function profilesBuilder() {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      single: () => Promise.resolve({ data: { full_name: 'Ana Gomez', phone_number: '5493815559999', agency_name: 'Otra Inmobiliaria', email: 'ana@example.com' }, error: null })
    };
    return builder;
  }

  function blindMatchesBuilder() {
    return {
      insert: (rows: any[]) => ({
        select: () => Promise.resolve({ data: matchInsertIds.slice(0, rows.length).map((id) => ({ id })), error: null })
      })
    };
  }

  return {
    from: (table: string) => {
      if (table === 'active_searches') return activeSearchesBuilder();
      if (table === 'profiles') return profilesBuilder();
      if (table === 'blind_matches') return blindMatchesBuilder();
      throw new Error(`Tabla no mockeada en este test: ${table}`);
    }
  };
}

test('KAN-303 integración (búsqueda→cartera) - dos matches nuevos del mismo dueño se agrupan en UN push con ambos ids en ?highlight=', async (t) => {
  t.mock.method(aiService, 'extractFromTextInput', async () => DEFAULT_EXTRACTED_DATA);
  t.mock.method(aiService, 'extractZoneIntent', async () => DEFAULT_ZONE_INTENT);
  t.mock.method(blindMatchingService, 'findCrossTenantMatches', async () => [
    sampleMatch({ tenant_id: 'tenant-owner-302' }),
    sampleMatch({ tenant_id: 'tenant-owner-302' })
  ]);
  t.mock.method(realtimeHubService, 'broadcastMatchCountChanged', () => {});

  // hasActivePushSubscriptions/sendWebPushToTenant no reciben cliente inyectado en esta dirección
  // (siempre usan el singleton real, ver src/services/searchSegmentProcessor.ts) — a diferencia de
  // la dirección cartera→búsqueda, acá SÍ hace falta mockear ambas para no pegarle a Supabase/
  // infra de push reales. buildIncomingMatchPushPayload sigue sin mockearse.
  t.mock.method(webPushService, 'hasActivePushSubscriptions', async () => true);
  const sendPushMock = t.mock.method(webPushService, 'sendWebPushToTenant', async () => true);
  const emailFallbackMock = t.mock.method(notifierEmailService, 'sendIncomingMatchEmailFallback', async () => true);

  const tenantSupabase = makeSearchSegmentTenantSupabaseMock(['match-uno', 'match-dos']);

  const result = await processSingleSearchSegment('tenant-searcher-302', tenantSupabase as any, 'busco casa en venta');
  await flushPendingNotification();

  assert.strictEqual(result.matches?.length, 2);
  assert.strictEqual(sendPushMock.mock.callCount(), 1, 'Dos matches del mismo dueño deben mandar un solo push agrupado, no uno por match.');
  assert.strictEqual(emailFallbackMock.mock.callCount(), 0);

  const [tenantIdArg, payloadArg] = sendPushMock.mock.calls[0].arguments as [string, Record<string, unknown>];
  assert.strictEqual(tenantIdArg, 'tenant-owner-302');
  assert.strictEqual((payloadArg.data as any).url, '/matches?highlight=match-uno%2Cmatch-dos');
});
