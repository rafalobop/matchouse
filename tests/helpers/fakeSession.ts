import crypto from 'crypto';
import { __setCachedSessionForTests } from '../../src/middleware/tenantAuth';
import { __setTenantClientForTests } from '../../src/services/supabase';

// KAN-76: arma una cookie de sesión de tenant válida contra el router real sin pegarle a Supabase
// de verdad — siembra el cache de sesión de tenantAuthMiddleware (token -> tenantId) y el cache de
// clientes por token (token -> cliente fake) que ya usa getTenantClient() en producción. El router
// bajo test corre 100% real (tenantAuthMiddleware real, controller real); solo el límite de red
// hacia Supabase queda stubbeado, mismo patrón de inyección en el límite que ya usa el resto del
// repo (fetchImpl en geocoding.ts/localitiesService.ts).
//
// Límite conocido: solo cubre `req.supabaseClient` (el cliente tenant-scoped que arma
// tenantAuthMiddleware). Un puñado de controllers (ej. searchController.ts#archiveSearch/
// reactivateSearch, el chequeo privilegiado de dueño) importan el singleton service-role
// (`services/supabase.ts#supabase`) directo, sin ningún seam de inyección — un test que ejercite
// esas ramas con este helper terminaría pegándole a Supabase de verdad. No se cubre acá a
// propósito (ver tests/routes/search.route.test.ts): habilitarlo requeriría agregar un
// `__setServiceRoleClientForTests` análogo, cambio de mayor alcance que se dejó fuera de este pase.
export function createFakeTenantSession(tenantSupabaseClient: any, tenantId: string = crypto.randomUUID()) {
  const token = crypto.randomUUID();
  __setCachedSessionForTests(token, tenantId);
  __setTenantClientForTests(token, tenantSupabaseClient);
  return { token, tenantId, cookie: `brokaza_session=${token}` };
}
