// KAN-306 (continuación, 2026-09-04): script de verificación manual de la RLS por agencia
// (current_agency_owner_id(), migración add_agency_shared_tenant_scope_2026-09-04.sql). Mismo
// patrón que scripts/test-rls.ts (KAN-63) — no es parte de `npm test`, requiere una conexión real
// a Supabase y crea/borra usuarios reales de auth.users vía Admin API. Se corre manualmente con
// `ts-node scripts/test-rls-agency.ts`.
//
// Escenario: dueño A, colaborador B (agency_owner_id = A), tercero sin relación C. Verifica que:
// - B ve/inserta/edita la cartera de A (RLS current_agency_owner_id() resuelve el scope de B a A).
// - B NO puede eliminar una propiedad de A (properties_owner_delete exige auth.uid() = tenant_id).
// - A sí puede eliminarla.
// - C (sin relación) no ve nada de la cartera de A (aislamiento entre agencias intacto).
// - Al revocar a B (agency_owner_id = null), pierde acceso a la cartera de A inmediatamente.

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

async function createTestProfile(label: string, opts: { agencyOwnerId?: string } = {}): Promise<string> {
  const email = `rls-agency-test-${label}-${randomUUID()}@rls-test.local`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    password: randomUUID()
  });
  if (error || !data?.user) {
    throw new Error(`No se pudo crear el usuario de prueba ${label}: ${error?.message}`);
  }
  const id = data.user.id;
  const { error: profileErr } = await supabase.from('profiles').upsert({
    id,
    email,
    full_name: `RLS Agency Test ${label}`,
    ...(opts.agencyOwnerId ? { role: 'collaborator', agency_owner_id: opts.agencyOwnerId } : {})
  });
  if (profileErr) {
    throw new Error(`No se pudo crear el profile de prueba ${label}: ${profileErr.message}`);
  }
  return id;
}

async function cleanupTestProfile(id: string) {
  await supabase.from('properties').delete().eq('tenant_id', id);
  await supabase.from('profiles').delete().eq('id', id);
  await supabase.auth.admin.deleteUser(id);
}

async function runAgencyRlsTest() {
  assertDevOnly('test-rls-agency.ts');

  console.log('=== INICIANDO PRUEBA DE RLS POR AGENCIA (KAN-306, continuación) ===\n');

  console.log('[TEST] Creando dueño A, colaborador B (agency_owner_id = A) y tercero C sin relación...');
  const ownerAId = await createTestProfile('owner-a');
  const collaboratorBId = await createTestProfile('collaborator-b', { agencyOwnerId: ownerAId });
  const unrelatedCId = await createTestProfile('unrelated-c');
  console.log(`[TEST] A: ${ownerAId} | B: ${collaboratorBId} | C: ${unrelatedCId}`);

  const tokenA = generateTenantToken(ownerAId, 'rls-agency-test-session-a');
  const tokenB = generateTenantToken(collaboratorBId, 'rls-agency-test-session-b');
  const tokenC = generateTenantToken(unrelatedCId, 'rls-agency-test-session-c');
  const clientA = getTenantClient(tokenA);
  const clientB = getTenantClient(tokenB);
  const clientC = getTenantClient(tokenC);

  let propId = '';

  try {
    console.log('\n[TEST] properties: A inserta una propiedad propia...');
    propId = randomUUID();
    const { error: insertErrA } = await clientA.from('properties').insert({
      id: propId,
      address: 'Cartera Agencia A 123',
      price: 120000,
      currency: 'USD',
      bedrooms: 2,
      features: 'Propiedad de prueba de agencia',
      contact_info: '123456',
      operation: 'venta',
      property_type: 'departamento',
      sheet_name: 'Cartera',
      latitude: 0,
      longitude: 0,
      tenant_id: ownerAId
    });
    check(!insertErrA, 'A insertó su propiedad correctamente.', `A no pudo insertar su propiedad: ${insertErrA?.message}`);

    console.log('[TEST] properties: B (colaborador) lee la cartera y ve la propiedad de A...');
    const { data: propsAsB, error: selectErrB } = await clientB.from('properties').select('*').eq('id', propId);
    check(!selectErrB, 'B pudo leer la cartera sin error.', `B no pudo leer la cartera: ${selectErrB?.message}`);
    check(!!propsAsB && propsAsB.length === 1, 'B ve la propiedad de A (cartera compartida).', `B no vio la propiedad de A: ${JSON.stringify(propsAsB)}`);

    console.log('[TEST] properties: B (colaborador) inserta una propiedad para la agencia de A...');
    const propIdFromB = randomUUID();
    const { error: insertErrB } = await clientB.from('properties').insert({
      id: propIdFromB,
      address: 'Cartera Agencia A 456 (cargada por colaborador)',
      price: 95000,
      currency: 'USD',
      bedrooms: 1,
      features: 'Cargada por colaborador',
      contact_info: '789123',
      operation: 'alquiler',
      property_type: 'casa',
      sheet_name: 'Cartera',
      latitude: 0,
      longitude: 0,
      tenant_id: ownerAId
    });
    check(!insertErrB, 'B pudo insertar una propiedad para la cartera de A.', `B no pudo insertar para la cartera de A: ${insertErrB?.message}`);

    console.log('[TEST] properties: B (colaborador) edita la propiedad original de A...');
    const { error: updateErrB } = await clientB.from('properties').update({ price: 130000 }).eq('id', propId);
    check(!updateErrB, 'B pudo editar la propiedad de A.', `B no pudo editar la propiedad de A: ${updateErrB?.message}`);

    console.log('[TEST] properties: B (colaborador) intenta ELIMINAR la propiedad de A (debe fallar)...');
    const { data: deleteAttemptB, error: deleteErrB } = await clientB
      .from('properties')
      .delete()
      .eq('id', propId)
      .select('id');
    const deleteBlocked = !deleteErrB && (!deleteAttemptB || deleteAttemptB.length === 0);
    check(
      deleteBlocked || !!deleteErrB,
      'B NO pudo eliminar la propiedad de A (bloqueado por properties_owner_delete).',
      `CRÍTICO: B (colaborador) pudo eliminar una propiedad de la agencia: ${JSON.stringify(deleteAttemptB)} / ${deleteErrB?.message}`
    );

    console.log('[TEST] properties: C (sin relación) NO ve la cartera de A...');
    const { data: propsAsC, error: selectErrC } = await clientC.from('properties').select('*').eq('id', propId);
    check(!selectErrC, 'C pudo consultar sin error (0 filas esperadas).', `Error inesperado consultando como C: ${selectErrC?.message}`);
    check(!propsAsC || propsAsC.length === 0, 'C no ve la cartera de A (aislamiento entre agencias intacto).', `CRÍTICO: C vio datos de la agencia de A: ${JSON.stringify(propsAsC)}`);

    console.log('[TEST] properties: A (dueño real) SÍ puede eliminar su propia propiedad...');
    const { data: deleteA, error: deleteErrA } = await clientA.from('properties').delete().eq('id', propId).select('id');
    check(!deleteErrA && !!deleteA && deleteA.length === 1, 'A pudo eliminar su propia propiedad.', `A no pudo eliminar su propia propiedad: ${JSON.stringify(deleteA)} / ${deleteErrA?.message}`);

    console.log('\n[TEST] Revocando a B (role=owner, agency_owner_id=null, como revokeCollaborator)...');
    const { error: revokeErr } = await supabase.from('profiles').update({ role: 'owner', agency_owner_id: null }).eq('id', collaboratorBId);
    if (revokeErr) throw new Error(`No se pudo revocar a B: ${revokeErr.message}`);

    console.log('[TEST] properties: B (ya revocado) ya NO ve la propiedad que B mismo cargó para A...');
    const { data: propsAfterRevoke, error: selectAfterRevokeErr } = await clientB.from('properties').select('*').eq('id', propIdFromB);
    check(!selectAfterRevokeErr, 'B (revocado) pudo consultar sin error (0 filas esperadas).', `Error inesperado consultando como B revocado: ${selectAfterRevokeErr?.message}`);
    check(!propsAfterRevoke || propsAfterRevoke.length === 0, 'B (revocado) perdió el acceso a la cartera de A inmediatamente.', `CRÍTICO: B revocado sigue viendo datos de la agencia de A: ${JSON.stringify(propsAfterRevoke)}`);

    console.log('[TEST] properties: limpiando la propiedad que quedó cargada por B antes de la revocación...');
    await supabase.from('properties').delete().eq('id', propIdFromB);
  } finally {
    console.log('\n[TEST] Limpiando usuarios y perfiles de prueba...');
    await cleanupTestProfile(ownerAId);
    await cleanupTestProfile(collaboratorBId);
    await cleanupTestProfile(unrelatedCId);
    console.log('✅ Limpieza completada.');
  }

  console.log(`\n=== PRUEBA DE RLS POR AGENCIA FINALIZADA: ${failures === 0 ? 'TODO OK ✅' : `${failures} CHECK(S) FALLARON ❌`} ===`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

runAgencyRlsTest().catch((err) => {
  console.error('Error inesperado ejecutando la prueba de RLS por agencia:', err);
  process.exitCode = 1;
});
