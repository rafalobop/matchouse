// KAN-63: script de verificación manual de RLS + patrón "Tenant Context".
// Reescrito para el schema v2 actual (profiles/properties/blind_matches en inglés, RLS
// tenant_id = auth.uid()) — la versión anterior de este script quedó rota tras SPEC-0012
// (referenciaba las tablas viejas "Tenant"/"Property" pre-refactor, ya inexistentes).
// KAN-78: match_queue (legacy WhatsApp) fue eliminada y reemplazada por blind_matches — la
// sección de prueba de esa tabla se reescribió contra el schema nuevo (ver más abajo).
//
// No es parte de `npm test` (requiere una conexión real a Supabase y crea/borra usuarios
// reales de auth.users vía Admin API) — se corre manualmente con `ts-node scripts/test-rls.ts`.
// Crea 2 tenants de prueba desechables (auth.users + profiles), ejercita getTenantClient()
// (el mismo mecanismo que ahora usa tenantAuthMiddleware en producción) y limpia todo al
// final, corra como corra el resultado de los checks.

import { generateTenantToken, getTenantClient, supabase } from '../src/services/supabase';
import { randomUUID } from 'crypto';
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

async function createTestTenant(label: string): Promise<string> {
  const email = `rls-test-${label}-${randomUUID()}@rls-test.local`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    password: randomUUID()
  });
  if (error || !data?.user) {
    throw new Error(`No se pudo crear el usuario de prueba ${label}: ${error?.message}`);
  }
  const tenantId = data.user.id;
  const { error: profileErr } = await supabase.from('profiles').upsert({
    id: tenantId,
    email,
    full_name: `RLS Test Tenant ${label}`
  });
  if (profileErr) {
    throw new Error(`No se pudo crear el profile de prueba ${label}: ${profileErr.message}`);
  }
  return tenantId;
}

async function cleanupTestTenant(tenantId: string) {
  await supabase.from('blind_matches').delete().eq('tenant_id', tenantId);
  await supabase.from('properties').delete().eq('tenant_id', tenantId);
  await supabase.from('profiles').delete().eq('id', tenantId);
  await supabase.auth.admin.deleteUser(tenantId);
}

async function runRlsTest() {
  assertDevOnly('test-rls.ts');

  console.log('=== INICIANDO PRUEBA DE ROW LEVEL SECURITY (RLS) — KAN-63 ===\n');

  console.log('[TEST] Creando Tenant A y Tenant B (auth.users + profiles reales, desechables)...');
  const tenantAId = await createTestTenant('a');
  const tenantBId = await createTestTenant('b');
  console.log(`[TEST] Tenant A: ${tenantAId} | Tenant B: ${tenantBId}`);

  // Mismo mecanismo que src/services/supabase.ts#getTenantClient usa en producción
  // (tenantAuthMiddleware, KAN-63): anon key + JWT del usuario como Bearer. generateTenantToken
  // firma un JWT válido para PostgREST con el mismo secreto de proyecto que un access_token real
  // de Supabase Auth usaría — no hace falta un login real por magic link para probar RLS.
  const tokenA = generateTenantToken(tenantAId, 'rls-test-session-a');
  const tokenB = generateTenantToken(tenantBId, 'rls-test-session-b');
  const clientA = getTenantClient(tokenA);
  const clientB = getTenantClient(tokenB);

  let propIdA = '';
  let propIdB = '';

  try {
    // --- PROPERTIES ---
    console.log('\n[TEST] properties: insertando propiedad propia con Cliente A (debe funcionar)...');
    propIdA = randomUUID();
    const { error: insertErrA } = await clientA.from('properties').insert({
      id: propIdA,
      address: 'Calle Falsa 123',
      price: 150000,
      currency: 'USD',
      bedrooms: 2,
      features: 'Propiedad de prueba A',
      contact_info: '123456',
      operation: 'venta',
      property_type: 'casa',
      sheet_name: 'Cartera',
      latitude: 0,
      longitude: 0,
      tenant_id: tenantAId
    });
    check(!insertErrA, 'Inserción propia exitosa (Tenant A).', `Inserción propia de Tenant A falló: ${insertErrA?.message}`);

    console.log('[TEST] properties: intentando insertar con tenant_id ajeno usando Cliente A (debe fallar)...');
    const { error: insertUsurpErr } = await clientA.from('properties').insert({
      id: randomUUID(),
      address: 'Calle Falsa 456',
      price: 85000,
      currency: 'USD',
      bedrooms: 1,
      features: 'Intento de usurpación',
      contact_info: '654321',
      operation: 'alquiler',
      property_type: 'departamento',
      sheet_name: 'Cartera',
      latitude: 0,
      longitude: 0,
      tenant_id: tenantBId
    });
    check(!!insertUsurpErr, `Inserción con tenant_id ajeno bloqueada por RLS correctamente: ${insertUsurpErr?.message}`, 'CRÍTICO: se pudo insertar una propiedad con tenant_id de otro tenant.');

    console.log('[TEST] properties: insertando propiedad propia con Cliente B (para la prueba de lectura cruzada)...');
    propIdB = randomUUID();
    const { error: insertErrB } = await clientB.from('properties').insert({
      id: propIdB,
      address: 'Calle Falsa 789',
      price: 90000,
      currency: 'USD',
      bedrooms: 3,
      features: 'Propiedad de prueba B',
      contact_info: '789123',
      operation: 'venta',
      property_type: 'departamento',
      sheet_name: 'Cartera',
      latitude: 0,
      longitude: 0,
      tenant_id: tenantBId
    });
    check(!insertErrB, 'Inserción propia exitosa (Tenant B).', `Inserción propia de Tenant B falló: ${insertErrB?.message}`);

    console.log('[TEST] properties: leyendo con Cliente A (debe ver solo su propia propiedad)...');
    const { data: propsA, error: selectErrA } = await clientA.from('properties').select('*');
    check(!selectErrA, 'Lectura de Cliente A sin errores.', `Error al leer propiedades con Cliente A: ${selectErrA?.message}`);
    const soloPropiasA = !!propsA && propsA.every((p: any) => p.tenant_id === tenantAId) && propsA.some((p: any) => p.id === propIdA);
    check(soloPropiasA, `Aislamiento de lectura exitoso: Cliente A leyó ${propsA?.length} fila(s), todas propias.`, `CRÍTICO: Cliente A leyó ${propsA?.length} fila(s) y no todas son propias (posible fuga cross-tenant).`);

    // --- BLIND_MATCHES (KAN-78, reemplaza a MATCH_QUEUE) ---
    console.log('\n[TEST] blind_matches: insertando match propio con Cliente A (debe funcionar)...');
    const matchIdA = randomUUID();
    const { error: matchInsertErrA } = await clientA.from('blind_matches').insert({
      id: matchIdA,
      tenant_id: tenantAId,
      matched_tenant_id: tenantBId,
      raw_search_text: 'busco depto 2 dorm (prueba RLS KAN-78)',
      property_snapshot: { domicilio: 'Calle Falsa 789', precio: 90000, moneda: 'USD' },
      searcher_snapshot: { full_name: 'Tester A', phone_number: '5493810000001', agency_name: 'Inmobiliaria Test' },
      score: 80,
      reasons: ['Coincidencia de prueba RLS']
    });
    check(!matchInsertErrA, 'Inserción propia en blind_matches exitosa (Tenant A).', `Inserción propia en blind_matches falló: ${matchInsertErrA?.message}`);

    console.log('[TEST] blind_matches: intentando insertar con tenant_id ajeno usando Cliente A (debe fallar)...');
    const { error: matchUsurpErr } = await clientA.from('blind_matches').insert({
      id: randomUUID(),
      tenant_id: tenantBId,
      matched_tenant_id: tenantAId,
      raw_search_text: 'intento de usurpación de blind_matches',
      property_snapshot: { domicilio: 'Calle Falsa 123', precio: 150000, moneda: 'USD' },
      searcher_snapshot: { full_name: 'Usurpador', phone_number: null, agency_name: null },
      score: 50,
      reasons: []
    });
    check(!!matchUsurpErr, `Inserción en blind_matches con tenant_id ajeno bloqueada correctamente: ${matchUsurpErr?.message}`, 'CRÍTICO: se pudo insertar un blind_match con tenant_id de otro tenant.');

    console.log('[TEST] blind_matches: Cliente A lee sus propios matches (patrón real de GET /api/matches)...');
    const { data: matchesA, error: matchSelectErr } = await clientA
      .from('blind_matches')
      .select('*')
      .eq('tenant_id', tenantAId);
    check(!matchSelectErr, 'Lectura de blind_matches sin errores bajo RLS.', `Error en lectura de blind_matches: ${matchSelectErr?.message}`);
    const soloPropiosA = !!matchesA && matchesA.length === 1 && matchesA[0].id === matchIdA;
    check(soloPropiosA, 'Aislamiento de lectura exitoso: Cliente A leyó solo su propio match.', `CRÍTICO: Cliente A no leyó exactamente su propio match: ${JSON.stringify(matchesA)}`);

    console.log('[TEST] blind_matches: Cliente B lee el match donde es matched_tenant_id (patrón real de GET /api/matches/incoming)...');
    const { data: incomingB, error: incomingSelectErr } = await clientB
      .from('blind_matches')
      .select('*')
      .eq('matched_tenant_id', tenantBId);
    check(!incomingSelectErr, 'Lectura de matches entrantes (Cliente B) sin errores bajo RLS.', `Error en lectura de matches entrantes: ${incomingSelectErr?.message}`);
    const incomingOk = !!incomingB && incomingB.length === 1 && incomingB[0].id === matchIdA;
    check(incomingOk, 'Policy de solo lectura para matched_tenant_id funciona: Cliente B ve el match donde es el dueño de la propiedad.', `CRÍTICO: Cliente B no vio el match entrante esperado: ${JSON.stringify(incomingB)}`);

    console.log('[TEST] blind_matches: Cliente B intenta editar user_review_status del match ajeno (debe fallar/no afectar filas)...');
    const { data: updateAttempt, error: updateAttemptErr } = await clientB
      .from('blind_matches')
      .update({ user_review_status: 'ACCEPTED' })
      .eq('id', matchIdA)
      .select('id');
    const updateBlocked = !updateAttemptErr && (!updateAttempt || updateAttempt.length === 0);
    check(updateBlocked || !!updateAttemptErr, 'Edición del match ajeno bloqueada por RLS (Cliente B solo tiene policy de SELECT).', `CRÍTICO: Cliente B pudo editar un blind_match del que no es tenant_id: ${JSON.stringify(updateAttempt)} / ${updateAttemptErr?.message}`);

  } finally {
    console.log('\n[TEST] Limpiando datos y usuarios de prueba...');
    await cleanupTestTenant(tenantAId);
    await cleanupTestTenant(tenantBId);
    console.log('✅ Limpieza completada.');
  }

  console.log(`\n=== PRUEBA DE RLS FINALIZADA: ${failures === 0 ? 'TODO OK ✅' : `${failures} CHECK(S) FALLARON ❌`} ===`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

runRlsTest().catch((err) => {
  console.error('Error inesperado ejecutando la prueba de RLS:', err);
  process.exitCode = 1;
});
