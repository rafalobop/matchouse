import * as express from 'express';
import { randomUUID } from 'crypto';
import { supabase } from '../services/supabase';
import { config } from '../config/env';
import { isValidUUID } from '../utils/idValidation';
import { validateBodyWhitelist } from '../utils/bodyWhitelist';
import { logger } from '../services/logger';
import { sendMagicLinkEmail, sendCollaboratorAccessGrantedEmail } from '../services/notifier-email';

// KAN-306: panel de administración de agencia — solo un tenant con `profiles.role = 'owner'`
// puede listar, otorgar y revocar el acceso de colaboradores. `role`/`agency_owner_id` tienen
// `REVOKE UPDATE ... FROM authenticated` (migración kan306_add_role_and_agency_owner_to_profiles):
// ni siquiera el propio dueño podría escribirlas con `req.supabaseClient` (patrón Tenant Context,
// KAN-63) aunque quisiera, así que toda escritura acá usa el cliente service-role a propósito.
// Alcance deliberado de este ticket (acordado con el usuario): solo el rol y el vínculo
// dueño/colaborador para gatear el acceso al panel. Compartir la cartera/búsquedas/matches del
// dueño con sus colaboradores (RLS por `agency_owner_id` en vez de solo `id = auth.uid()`) queda
// fuera de alcance — cada colaborador sigue viendo únicamente sus propios datos vía RLS existente.

async function requireOwner(tenantId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', tenantId)
    .maybeSingle();

  if (error) throw error;
  if (!profile) {
    return { ok: false, status: 404, error: 'Perfil no encontrado.' };
  }
  if (profile.role !== 'owner') {
    return { ok: false, status: 403, error: 'Solo los dueños de agencia pueden acceder al panel de administración.' };
  }
  return { ok: true };
}

export async function listCollaborators(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;

  try {
    const ownerCheck = await requireOwner(tenantId);
    if (!ownerCheck.ok) {
      return res.status(ownerCheck.status).json({ error: ownerCheck.error });
    }

    // KAN-306 (AC6, supervisión de usuarios temporales): se reusa este mismo listado en vez de
    // sumar un endpoint nuevo — el dueño ya lo consulta para ver a sus colaboradores, agregar
    // license_number/license_validation_status alcanza para que pueda distinguir a los que están
    // 'pending'/'rejected' de los ya 'validated'.
    const { data: collaborators, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, license_number, license_validation_status, created_at')
      .eq('agency_owner_id', tenantId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({ collaborators: collaborators ?? [] });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[ADMIN_PANEL] Error al listar colaboradores');
    res.status(500).json({ error: 'Error interno al listar los colaboradores.' });
  }
}

// KAN-306 (cambio de flujo, pedido explícito del usuario tras el primer pase): el dueño ya no
// necesita que el colaborador se haya registrado antes — invitar por email siempre funciona.
// - Si el email ya tiene cuenta: se vincula directo (comportamiento previo) y se le avisa por
//   mail que ya tiene acceso.
// - Si no existe: se crea la cuenta (Supabase Auth + profiles, ya vinculada a la agencia desde
//   el origen) y se le manda el magic link de bienvenida — mismo mecanismo que
//   `POST /api/auth/request-magic-link` (`authController.ts`), generado acá server-side porque
//   no hay un login previo del propio invitado que lo dispare.
// Los colaboradores no pasan por la validación de matrícula (ver `profileController.ts#updateProfile`)
// — operan bajo la del dueño de su agencia, decisión de producto acordada con el usuario.
export async function inviteCollaborator(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const { email } = req.body;

  const bodyWhitelistError = validateBodyWhitelist(req.body, ['email']);
  if (bodyWhitelistError) {
    return res.status(400).json({ error: bodyWhitelistError });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Email inválido.' });
  }
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const ownerCheck = await requireOwner(tenantId);
    if (!ownerCheck.ok) {
      return res.status(ownerCheck.status).json({ error: ownerCheck.error });
    }

    const { data: target, error: fetchError } = await supabase
      .from('profiles')
      .select('id, agency_owner_id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (target) {
      if (target.id === tenantId) {
        return res.status(400).json({ error: 'No podés otorgarte acceso a vos mismo.' });
      }
      if (target.agency_owner_id === tenantId) {
        return res.status(409).json({ error: 'Ese usuario ya es colaborador de tu agencia.' });
      }
      if (target.agency_owner_id) {
        return res.status(409).json({ error: 'Ese usuario ya es colaborador de otra agencia.' });
      }

      const { data: updated, error: updateError } = await supabase
        .from('profiles')
        .update({ role: 'collaborator', agency_owner_id: tenantId })
        .eq('id', target.id)
        .select('id, full_name, email, created_at')
        .single();

      if (updateError) throw updateError;

      logger.info({ tenantId, collaboratorId: target.id }, '[AUDITORIA] Acceso de colaborador otorgado (cuenta ya existente)');

      // Fire-and-forget: un fallo de email no debe tirar abajo el otorgamiento de acceso, que ya
      // quedó persistido — mismo criterio que `sendWebPushToTenant` en `searchController.ts`.
      sendCollaboratorAccessGrantedEmail(normalizedEmail).catch((err: any) => {
        logger.error({ error: err.message || err, tenantId, collaboratorId: target.id }, '[ADMIN_PANEL] Error al enviar el email de acceso otorgado.');
      });

      return res.json({ success: true, collaborator: updated });
    }

    // No existe la cuenta: se crea (KAN-306, cambio de flujo) — mismo patrón que los scripts de
    // prueba desechables de este repo (`createUser` + password aleatoria nunca usada, el único
    // login real es magic link).
    const { data: createdUser, error: createUserError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      email_confirm: true,
      password: randomUUID()
    });
    if (createUserError || !createdUser?.user) {
      logger.error({ error: createUserError?.message, tenantId, email: normalizedEmail }, '[ADMIN_PANEL] No se pudo crear la cuenta del colaborador invitado.');
      return res.status(502).json({ error: 'No pudimos crear la cuenta del colaborador. Intentá de nuevo.' });
    }
    const collaboratorId = createdUser.user.id;

    const { error: profileError } = await supabase.from('profiles').upsert({
      id: collaboratorId,
      email: normalizedEmail,
      full_name: '',
      role: 'collaborator',
      agency_owner_id: tenantId
    });
    if (profileError) throw profileError;

    // KAN-269: mismo mecanismo que `requestMagicLink` (`authController.ts`) — `generateLink` no
    // manda ningún email por sí solo, se manda por Resend con el template propio.
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: normalizedEmail,
      options: { redirectTo: config.appUrl }
    });
    const actionLink = linkData?.properties?.action_link;

    if (linkError || !actionLink) {
      // La cuenta ya quedó creada y vinculada a la agencia — el colaborador puede pedir su
      // propio magic link desde el login normal con este mismo email, así que no revertimos
      // nada acá. Solo logueamos para que quede visible que el mail de bienvenida no salió.
      logger.error({ error: linkError?.message, tenantId, collaboratorId }, '[ADMIN_PANEL] Cuenta de colaborador creada pero no se pudo generar el link de acceso.');
    } else {
      const sent = await sendMagicLinkEmail(normalizedEmail, actionLink, true);
      if (!sent) {
        logger.error({ tenantId, collaboratorId }, '[ADMIN_PANEL] Cuenta de colaborador creada pero no se pudo enviar el email de bienvenida.');
      }
    }

    logger.info({ tenantId, collaboratorId }, '[AUDITORIA] Cuenta de colaborador creada e invitada por email');

    res.json({
      success: true,
      collaborator: { id: collaboratorId, full_name: '', email: normalizedEmail, created_at: createdUser.user.created_at }
    });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[ADMIN_PANEL] Error al otorgar acceso de colaborador');
    res.status(500).json({ error: 'Error interno al otorgar el acceso.' });
  }
}

export async function revokeCollaborator(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'El ID del colaborador está mal formado.' });
  }

  try {
    const ownerCheck = await requireOwner(tenantId);
    if (!ownerCheck.ok) {
      return res.status(ownerCheck.status).json({ error: ownerCheck.error });
    }

    const { data: target, error: fetchError } = await supabase
      .from('profiles')
      .select('id, agency_owner_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!target) {
      return res.status(404).json({ error: 'El colaborador no existe.' });
    }
    if (target.agency_owner_id !== tenantId) {
      return res.status(403).json({ error: 'No tenés permiso para revocar el acceso de este colaborador.' });
    }

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ role: 'owner', agency_owner_id: null })
      .eq('id', id);

    if (updateError) throw updateError;

    logger.info({ tenantId, collaboratorId: id }, '[AUDITORIA] Acceso de colaborador revocado');

    res.json({ success: true });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId, collaboratorId: id }, '[ADMIN_PANEL] Error al revocar acceso de colaborador');
    res.status(500).json({ error: 'Error interno al revocar el acceso.' });
  }
}
