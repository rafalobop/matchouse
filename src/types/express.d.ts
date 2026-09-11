import type { TypedSupabaseClient } from '../services/supabase';
import type { AdminIdentity } from '../adminAuth';

// Augmenta Express.Request con las propiedades que los middlewares de auth (tenantAuthMiddleware
// en middleware/tenantAuth.ts, adminAuthMiddleware en adminAuth.ts) cuelgan del request antes de
// que lleguen los controllers. Sin esto, cada acceso se casteaba a `(req as any).x`, perdiendo el
// chequeo del compilador ante typos en el nombre de la propiedad.
declare global {
  namespace Express {
    interface Request {
      // Seteado por tenantAuthMiddleware, que corta la request con 401 antes de llamar next() si no
      // puede resolverlos — todo handler montado detrás de ese middleware los tiene garantizados,
      // por eso se declaran no-opcionales (mismo patrón que req.admin/adminAuthMiddleware abajo).

      // "Scope efectivo de agencia" — el id del dueño, no necesariamente auth.uid() (ver nota en
      // middleware/tenantAuth.ts).
      tenantId: string;
      // auth.uid() real, sin resolver a través de agency_owner_id.
      actorId: string;
      // Cliente Supabase scoped al tenant (anon key + access_token del usuario), para que
      // PostgREST aplique RLS real.
      supabaseClient: TypedSupabaseClient;
      // Seteado por adminAuthMiddleware, con la misma garantía (401 antes de next() si falta).
      admin: AdminIdentity;
    }
  }
}

export {};
