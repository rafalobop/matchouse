import { generateTenantToken, getTenantClient, supabase } from './services/supabase';
import { randomUUID } from 'crypto';

async function runRlsTest() {
  console.log('=== INICIANDO PRUEBA DE ROW LEVEL SECURITY (RLS) ===\n');

  // 1. Crear dos tenants de prueba en la base de datos (usando service role)
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();

  console.log(`[TEST] Registrando Tenant A (${tenantAId})...`);
  const { error: errA } = await supabase.from('Tenant').insert({
    id: tenantAId,
    name: 'Tenant Prueba A',
    phone_number: '5493810000001@s.whatsapp.net',
    active_session_token: randomUUID()
  });
  if (errA) console.error('❌ Error al registrar Tenant A:', errA);

  console.log(`[TEST] Registrando Tenant B (${tenantBId})...`);
  const { error: errB } = await supabase.from('Tenant').insert({
    id: tenantBId,
    name: 'Tenant Prueba B',
    phone_number: '5493810000002@s.whatsapp.net',
    active_session_token: randomUUID()
  });
  if (errB) console.error('❌ Error al registrar Tenant B:', errB);

  // 2. Generar tokens JWT para cada uno
  const tokenA = generateTenantToken(tenantAId, 'session-test-a');
  const tokenB = generateTenantToken(tenantBId, 'session-test-b');

  // 3. Inicializar clientes de Supabase con RLS (anon key + JWT)
  const clientA = getTenantClient(tokenA);
  const clientB = getTenantClient(tokenB);

  try {
    // 4. Intentar insertar propiedad de Tenant A usando el cliente de Tenant A (Debe funcionar)
    console.log('\n[TEST] Intentando insertar propiedad para Tenant A usando Cliente A...');
    const propIdA = randomUUID();
    const { error: insertErrA } = await clientA.from('Property').insert({
      id: propIdA,
      domicilio: 'Calle Falsa 123',
      precio: 150000,
      moneda: 'USD',
      expensas: 0,
      dormitorios: 2,
      caracteristicas: 'Propiedad de prueba A',
      contacto: '123456',
      zona: 'Yerba Buena',
      operacion: 'venta',
      tipoPropiedad: 'casa',
      sheetName: 'Cartera',
      tenant_id: tenantAId // Debe coincidir con auth.uid()
    });

    if (insertErrA) {
      console.error('❌ Error al insertar propiedad propia de Tenant A:', insertErrA);
    } else {
      console.log('✅ Inserción exitosa de propiedad propia.');
    }

    // 5. Intentar insertar propiedad con tenant_id de Tenant B usando el cliente de Tenant A (Debe fallar por RLS policy violation)
    console.log('\n[TEST] Intentando insertar propiedad para Tenant B usando Cliente A...');
    const propIdB = randomUUID();
    const { error: insertErrB } = await clientA.from('Property').insert({
      id: propIdB,
      domicilio: 'Calle Falsa 456',
      precio: 85000,
      moneda: 'USD',
      expensas: 0,
      dormitorios: 1,
      caracteristicas: 'Propiedad de prueba B',
      contacto: '654321',
      zona: 'San Miguel de Tucumán',
      operacion: 'alquiler',
      tipoPropiedad: 'departamento',
      sheetName: 'Cartera',
      tenant_id: tenantBId // Intento de usurpar tenant_id
    });

    if (insertErrB) {
      console.log('✅ Inserción falló correctamente por violación de RLS:', insertErrB.message);
    } else {
      console.error('❌ ERROR CRÍTICO: ¡Se pudo insertar una propiedad de otro tenant!');
    }

    // 6. Insertar propiedad de B usando cliente B para poder hacer pruebas de lectura
    await supabase.from('Property').insert({
      id: propIdB,
      domicilio: 'Calle Falsa 456',
      precio: 85000,
      moneda: 'USD',
      expensas: 0,
      dormitorios: 1,
      caracteristicas: 'Propiedad de prueba B',
      contacto: '654321',
      zona: 'San Miguel de Tucumán',
      operacion: 'alquiler',
      tipoPropiedad: 'departamento',
      sheetName: 'Cartera',
      tenant_id: tenantBId
    });

    // 7. Intentar leer todas las propiedades usando Cliente A (Debe retornar SOLO la propiedad de A)
    console.log('\n[TEST] Leyendo propiedades con Cliente A...');
    const { data: propsA, error: selectErrA } = await clientA.from('Property').select('*');
    if (selectErrA) {
      console.error('❌ Error al leer propiedades con Cliente A:', selectErrA);
    } else {
      console.log(`[TEST] Cliente A leyó ${propsA?.length} propiedades.`);
      const containsOther = propsA?.some(p => p.tenant_id !== tenantAId);
      if (containsOther) {
        console.error('❌ ERROR CRÍTICO: ¡El Cliente A pudo leer propiedades de otro tenant!');
      } else {
        console.log('✅ Aislamiento de lectura exitoso (solo leyó datos del Tenant A).');
      }
    }

  } finally {
    // 8. Limpiar datos de prueba usando el rol de servicio
    console.log('\n[TEST] Limpiando datos de prueba...');
    await supabase.from('Property').delete().eq('tenant_id', tenantAId);
    await supabase.from('Property').delete().eq('tenant_id', tenantBId);
    await supabase.from('Tenant').delete().eq('id', tenantAId);
    await supabase.from('Tenant').delete().eq('id', tenantBId);
    console.log('✅ Limpieza completada.');
  }

  console.log('\n=== PRUEBA DE RLS FINALIZADA ===');
}

runRlsTest().catch(console.error);
