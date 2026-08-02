import test from 'node:test';
import assert from 'node:assert';
import { processPropertyUploaded } from '../src/services/propertyMatchWebhook';
import { registerSocket, unregisterSocket } from '../src/services/realtimeHub';

const PROPERTY_ROW = {
  id: 'prop-1',
  tenant_id: 'tenant-owner',
  address: 'Calle Nueva 100',
  price: 100000,
  currency: 'USD',
  bedrooms: 2,
  operation: 'venta',
  property_type: 'casa',
  sheet_name: 'Ventas'
};

function sampleSearchRow(overrides: Partial<any> = {}) {
  return {
    id: 'search-1',
    tenant_id: 'tenant-searcher',
    raw_text: 'busco casa',
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

// Mock de cliente Supabase que cubre todas las tablas que toca processPropertyUploaded:
// properties (carga de la propiedad), active_searches (candidatos), blind_matches (dedup +
// insert), profiles (snapshot del buscador + lookup de email de notifier-email.ts) y
// web_push_subscriptions (hasActivePushSubscriptions). Se deja SIEMPRE sin suscripciones push
// activas y sin email en profiles para que el camino de notificación se corte temprano (false)
// sin llegar a tocar webpush/Resend reales — hasActivePushSubscriptions/sendBlindMatchEmailFallback/
// sendIncomingMatchEmailFallback SÍ reciben este mismo cliente inyectado (ver
// src/services/propertyMatchWebhook.ts), a diferencia de sendWebPushToTenant, que siempre usa el
// singleton real y por eso nunca debe llegar a invocarse en este test.
function makeMockClient(options: {
  searchRows?: any[];
  existingDupCount?: number;
  insertErrorOnCallIndex?: number;
  profilesByTenant?: Record<string, any>;
} = {}) {
  const calls: { table: string; method: string; args: any[] }[] = [];
  let insertCallIndex = 0;

  function propertiesBuilder() {
    const builder: any = {
      select: (...args: any[]) => { calls.push({ table: 'properties', method: 'select', args }); return builder; },
      eq: (...args: any[]) => { calls.push({ table: 'properties', method: 'eq', args }); return builder; },
      single: () => Promise.resolve({ data: PROPERTY_ROW, error: null })
    };
    return builder;
  }

  function activeSearchesBuilder() {
    const builder: any = {
      select: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'select', args }); return builder; },
      eq: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'eq', args }); return builder; },
      neq: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'neq', args }); return builder; },
      or: (...args: any[]) => { calls.push({ table: 'active_searches', method: 'or', args }); return builder; },
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: options.searchRows ?? [], error: null }).then(resolve, reject)
    };
    return builder;
  }

  function blindMatchesBuilder() {
    return {
      select: (...args: any[]) => {
        calls.push({ table: 'blind_matches', method: 'select', args });
        const chain: any = {
          eq: (...eqArgs: any[]) => { calls.push({ table: 'blind_matches', method: 'eq', args: eqArgs }); return chain; },
          then: (resolve: any, reject: any) =>
            Promise.resolve({ count: options.existingDupCount ?? 0, error: null }).then(resolve, reject)
        };
        return chain;
      },
      insert: (row: any) => {
        calls.push({ table: 'blind_matches', method: 'insert', args: [row] });
        const currentIndex = insertCallIndex++;
        const error = currentIndex === options.insertErrorOnCallIndex ? { message: 'fallo simulado de insert' } : null;
        return Promise.resolve({ data: null, error });
      }
    };
  }

  function profilesBuilder() {
    let lastEqValue: string | undefined;
    const builder: any = {
      select: (...args: any[]) => { calls.push({ table: 'profiles', method: 'select', args }); return builder; },
      eq: (...args: any[]) => { calls.push({ table: 'profiles', method: 'eq', args }); lastEqValue = args[1]; return builder; },
      single: () => {
        const row = options.profilesByTenant?.[lastEqValue as string];
        return Promise.resolve({ data: row ?? null, error: row ? null : { message: 'no encontrado' } });
      }
    };
    return builder;
  }

  function webPushSubscriptionsBuilder() {
    return {
      select: (...args: any[]) => {
        calls.push({ table: 'web_push_subscriptions', method: 'select', args });
        const chain: any = {
          eq: (...eqArgs: any[]) => {
            calls.push({ table: 'web_push_subscriptions', method: 'eq', args: eqArgs });
            return Promise.resolve({ count: 0, error: null });
          }
        };
        return chain;
      }
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
    },
    calls
  };
}

test('processPropertyUploaded (KAN-79) - sin active_searches candidatas, no inserta ni notifica', async () => {
  const mockClient = makeMockClient({ searchRows: [] });

  const result = await processPropertyUploaded('prop-1', mockClient as any);

  assert.deepStrictEqual(result, { propertyId: 'prop-1', matchesFound: 0, matchesInserted: 0, matchesSkippedDuplicate: 0 });
  assert.ok(!mockClient.calls.some(c => c.table === 'blind_matches'), 'No debe tocar blind_matches si no hay candidatos.');
});

test('processPropertyUploaded (KAN-79) - un match nuevo (no duplicado) se inserta con property_id para dedup', async () => {
  const mockClient = makeMockClient({ searchRows: [sampleSearchRow()], existingDupCount: 0 });

  const result = await processPropertyUploaded('prop-1', mockClient as any);

  assert.strictEqual(result.matchesFound, 1);
  assert.strictEqual(result.matchesInserted, 1);
  assert.strictEqual(result.matchesSkippedDuplicate, 0);

  const insertCall = mockClient.calls.find(c => c.table === 'blind_matches' && c.method === 'insert');
  assert.ok(insertCall, 'Debe haber insertado una fila en blind_matches.');
  const row = insertCall!.args[0];
  assert.strictEqual(row.tenant_id, 'tenant-searcher');
  assert.strictEqual(row.matched_tenant_id, 'tenant-owner');
  assert.strictEqual(row.search_id, 'search-1');
  assert.strictEqual(row.property_id, 'prop-1');
  assert.strictEqual(row.raw_search_text, 'busco casa');
});

test('processPropertyUploaded (KAN-79) - un match ya existente (mismo search_id + property_id) se saltea sin insertar de nuevo', async () => {
  const mockClient = makeMockClient({ searchRows: [sampleSearchRow()], existingDupCount: 1 });

  const result = await processPropertyUploaded('prop-1', mockClient as any);

  assert.strictEqual(result.matchesFound, 1);
  assert.strictEqual(result.matchesInserted, 0);
  assert.strictEqual(result.matchesSkippedDuplicate, 1);
  assert.ok(!mockClient.calls.some(c => c.table === 'blind_matches' && c.method === 'insert'), 'No debe insertar un match ya persistido.');
});

test('processPropertyUploaded (KAN-79) - si falla el insert de un match, continúa con el resto (best-effort)', async () => {
  const mockClient = makeMockClient({
    searchRows: [sampleSearchRow({ id: 'search-1', tenant_id: 'tenant-a' }), sampleSearchRow({ id: 'search-2', tenant_id: 'tenant-b' })],
    existingDupCount: 0,
    insertErrorOnCallIndex: 0
  });

  const result = await processPropertyUploaded('prop-1', mockClient as any);

  assert.strictEqual(result.matchesFound, 2);
  assert.strictEqual(result.matchesInserted, 1, 'El primer insert falla, pero el segundo debe seguir intentándose y tener éxito.');
});

test('processPropertyUploaded (KAN-79) - usa el snapshot del buscador (profiles) al construir la fila', async () => {
  const mockClient = makeMockClient({
    searchRows: [sampleSearchRow()],
    existingDupCount: 0,
    profilesByTenant: { 'tenant-searcher': { full_name: 'Juan Perez', phone_number: '5493815551234', agency_name: 'Inmobiliaria Test', email: 'juan.perez@example.com' } }
  });

  await processPropertyUploaded('prop-1', mockClient as any);

  const insertCall = mockClient.calls.find(c => c.table === 'blind_matches' && c.method === 'insert');
  assert.deepStrictEqual(insertCall!.args[0].searcher_snapshot, {
    full_name: 'Juan Perez',
    phone_number: '5493815551234',
    agency_name: 'Inmobiliaria Test',
    email: 'juan.perez@example.com'
  });
});

test('processPropertyUploaded (KAN-89) - perfil del buscador sin email cae a null sin romper el snapshot', async () => {
  const mockClient = makeMockClient({
    searchRows: [sampleSearchRow()],
    existingDupCount: 0,
    profilesByTenant: { 'tenant-searcher': { full_name: 'Juan Perez', phone_number: '5493815551234', agency_name: 'Inmobiliaria Test' } }
  });

  await processPropertyUploaded('prop-1', mockClient as any);

  const insertCall = mockClient.calls.find(c => c.table === 'blind_matches' && c.method === 'insert');
  assert.strictEqual(insertCall!.args[0].searcher_snapshot.email, null);
});

test('processPropertyUploaded (KAN-79) - si falla el chequeo de duplicados (fail-open), igual intenta insertar', async () => {
  const mockClient = makeMockClient({ searchRows: [sampleSearchRow()] });
  // Sobreescribe blind_matches para simular un error en el select de dedup.
  const originalFrom = mockClient.from;
  (mockClient as any).from = (table: string) => {
    if (table === 'blind_matches') {
      return {
        select: () => ({
          eq: function (this: any) { return this; },
          then: (resolve: any) => resolve({ count: null, error: { message: 'fallo simulado de dedup' } })
        }),
        insert: (row: any) => { mockClient.calls.push({ table: 'blind_matches', method: 'insert', args: [row] }); return Promise.resolve({ data: null, error: null }); }
      };
    }
    return originalFrom(table);
  };

  const result = await processPropertyUploaded('prop-1', mockClient as any);

  assert.strictEqual(result.matchesInserted, 1, 'Un error en el chequeo de duplicados no debe bloquear la persistencia (fail-open).');
});

function makeFakeSocket() {
  const sent: string[] = [];
  return { readyState: 1, OPEN: 1, sent, send: (payload: string) => { sent.push(payload); } } as any;
}

test('processPropertyUploaded (KAN-88) - un match nuevo avisa por WS al buscador y al dueño de la propiedad, sin duplicar', async () => {
  const mockClient = makeMockClient({
    searchRows: [
      sampleSearchRow({ id: 'search-1', tenant_id: 'tenant-searcher' }),
      sampleSearchRow({ id: 'search-2', tenant_id: 'tenant-searcher' })
    ],
    existingDupCount: 0
  });

  const searcherSocket = makeFakeSocket();
  const ownerSocket = makeFakeSocket();
  registerSocket('tenant-searcher', searcherSocket);
  registerSocket('tenant-owner', ownerSocket);

  try {
    await processPropertyUploaded('prop-1', mockClient as any);

    assert.strictEqual(searcherSocket.sent.length, 1, 'Dos matches nuevos del mismo tenant deben generar un solo evento WS, no uno por match.');
    assert.deepStrictEqual(JSON.parse(searcherSocket.sent[0]), { type: 'match_count_changed' });
    assert.strictEqual(ownerSocket.sent.length, 1);
  } finally {
    unregisterSocket('tenant-searcher', searcherSocket);
    unregisterSocket('tenant-owner', ownerSocket);
  }
});

test('processPropertyUploaded (KAN-88) - sin matches nuevos (todo duplicado), no manda eventos WS', async () => {
  const mockClient = makeMockClient({ searchRows: [sampleSearchRow()], existingDupCount: 1 });

  const searcherSocket = makeFakeSocket();
  registerSocket('tenant-searcher', searcherSocket);

  try {
    await processPropertyUploaded('prop-1', mockClient as any);
    assert.strictEqual(searcherSocket.sent.length, 0);
  } finally {
    unregisterSocket('tenant-searcher', searcherSocket);
  }
});
