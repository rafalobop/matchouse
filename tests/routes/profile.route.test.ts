import test from 'node:test';
import assert from 'node:assert';
import { profileRoutes } from '../../src/routes/profileRoutes';
import { startTestServer, TestServer } from '../helpers/testServer';
import { createFakeTenantSession } from '../helpers/fakeSession';
import { chainableResult, createFakeSupabaseClient } from '../helpers/fakeSupabaseClient';

// KAN-76: contrato HTTP real de src/routes/profileRoutes.ts (el router activo). Reemplaza a
// tests/routes/profile.route.test.ts, que testeaba src/routes/profile.ts — código muerto desde
// el split a routes/*Routes.ts + controllers/*, nunca montado en la app real. La validación de
// negocio del body se testea aparte en tests/profileValidation.test.ts.

let server: TestServer;

test('routes/profileRoutes - setup', async () => {
  server = await startTestServer(profileRoutes);
});

test('KAN-76 - GET /api/localities/tucuman sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/localities/tucuman`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - GET /api/profile sin cookie responde 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/profile`);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - POST /api/profile sin cookie responde 401 (corta antes de validar el body)', async () => {
  const res = await fetch(`${server.baseUrl}/api/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'Juan' })
  });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'No autenticado.');
});

test('KAN-76 - GET /api/profile con cookie de sesión válida devuelve el perfil del tenant (integración con auth real, DB fake)', async () => {
  const fakeClient = createFakeSupabaseClient(() => chainableResult({
    data: { id: 'tenant-1', full_name: 'Juan Pérez', email: 'juan@example.com', phone_number: null, agency_name: null, city: null, country: null, profile_completed: false, created_at: new Date().toISOString() },
    error: null
  }));
  const { cookie } = createFakeTenantSession(fakeClient);

  const res = await fetch(`${server.baseUrl}/api/profile`, { headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.profile.full_name, 'Juan Pérez');
});

test('KAN-76 - POST /api/profile con cookie válida pero body con campo inesperado responde 400 (whitelist KAN-134)', async () => {
  const { cookie } = createFakeTenantSession(createFakeSupabaseClient(() => chainableResult({ data: null, error: null })));
  const res = await fetch(`${server.baseUrl}/api/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      first_name: 'Juan', last_name: 'Pérez', phone_number: '+543815551234',
      agency_name: 'Inmobiliaria Ejemplo', city: 'San Miguel de Tucumán', country: 'Otro país'
    })
  });
  assert.strictEqual(res.status, 400);
});

// KAN-306 (cambio de flujo de colaboradores): si license_number es obligatorio depende del rol
// del tenant (`role='owner'` lo exige, `role='collaborator'` no) — updateProfile ahora consulta
// ese rol con el cliente service-role real ANTES de validar el body, así que ya no hay forma de
// ejercitar "falta un campo del body → 400" sin tocar Supabase, a diferencia de antes. Mismo
// límite documentado en tests/routes/search.route.test.ts para el chequeo privilegiado de
// dueño (singleton service-role sin seam de inyección para tests). La validación de negocio en
// sí (license_number requerido según el rol) queda cubierta a nivel unitario en
// tests/profileValidation.test.ts.

test('routes/profileRoutes - teardown', async () => {
  await server.close();
});
