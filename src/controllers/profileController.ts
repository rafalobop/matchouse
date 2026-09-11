import * as express from 'express';
import { getTucumanLocalities } from '../services/localitiesService';
import { logger } from '../services/logger';
import { validateProfileInput } from '../utils/profileValidation';
import { validateBodyWhitelist } from '../utils/bodyWhitelist';
import { supabase } from '../services/supabase';
import { resolveLicenseValidationStatus } from '../services/licenseRegistry';

// KAN-93: única fuente de valores para el combobox de "Ciudad" del formulario de perfil —
// alcance geográfico fijo a Tucumán (decisión de negocio, ver .agent/CONTEXT.md), nunca un
// listado de otras provincias/países. Protegido por auth igual que el resto de /api/profile,
// aunque no dependa de datos del tenant — es contenido de referencia mostrado dentro del overlay
// de perfil, que solo aparece después del magic link.
export async function getTucumanLocalitiesHandler(req: express.Request, res: express.Response) {
  try {
    const localities = await getTucumanLocalities();
    res.json({ localities });
  } catch (error: any) {
    logger.error({ error: error.message || error }, '[PERFIL] Error inesperado al obtener localidades de Tucumán');
    res.status(500).json({ error: 'Error interno al obtener las localidades.' });
  }
}

export async function getProfile(req: express.Request, res: express.Response) {
  // KAN-306 (continuación, 2026-09-04): siempre `req.actorId` (el auth.uid() real), nunca
  // `req.tenantId` — este controller opera sobre "mi propio perfil". `tenantId` ahora puede
  // resolver al id del DUEÑO de la agencia (ver tenantAuthMiddleware); usarlo acá haría que un
  // colaborador intentara leer/editar el perfil de su dueño en vez del propio.
  const tenantId = req.actorId;
  const tenantSupabase = req.supabaseClient;

  try {
    const { data: profile, error } = await tenantSupabase
      .from('profiles')
      .select('id, full_name, email, phone_number, agency_name, city, country, profile_completed, license_number, license_validation_status, role, created_at')
      .eq('id', tenantId)
      .single();

    if (error) throw error;

    res.json({ profile });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[PERFIL] Error al obtener el perfil del tenant');
    res.status(500).json({ error: 'Error interno al obtener el perfil.' });
  }
}

export async function updateProfile(req: express.Request, res: express.Response) {
  // KAN-306 (continuación, 2026-09-04): `req.actorId`, mismo motivo que en getProfile de arriba.
  const tenantId = req.actorId;
  // KAN-90: first_name/last_name no tienen columnas propias en `profiles` (solo existe
  // `full_name`, un campo combinado desde SPEC-0012) — se piden separados en el formulario para
  // que queden marcados como dos campos obligatorios distintos (AC1), y acá se combinan en
  // `full_name` al persistir, sin necesidad de una migración de schema para este fix.
  // KAN-93: `country` ya NO se acepta del cliente — el negocio fija Argentina como único país
  // habilitado hasta tener un producto local sólido (decisión documentada en .agent/CONTEXT.md),
  // así que se hardcodea acá en vez de confiar en lo que mande el body (defensa en profundidad,
  // ni un payload manipulado puede setear otro país).
  const { first_name, last_name, phone_country_code, phone_local_number, agency_name, city, license_number } = req.body;

  // KAN-134: whitelist de campos del body — rechaza cualquier key inesperada antes de validar
  // el contenido de las esperadas.
  const bodyWhitelistError = validateBodyWhitelist(req.body, ['first_name', 'last_name', 'phone_country_code', 'phone_local_number', 'agency_name', 'city', 'license_number']);
  if (bodyWhitelistError) {
    return res.status(400).json({ error: bodyWhitelistError });
  }

  // KAN-306 (cambio de flujo de colaboradores): un tenant `role='collaborator'` opera bajo la
  // matrícula ya validada del dueño de su agencia — no se le exige la propia. Necesitamos el rol
  // actual antes de validar el body (determina si license_number es obligatorio) y antes de
  // decidir qué rama de persistencia usar.
  try {
    const { data: currentProfile, error: roleFetchError } = await supabase
      .from('profiles')
      .select('role, agency_owner_id')
      .eq('id', tenantId)
      .single();
    if (roleFetchError) throw roleFetchError;

    const isCollaborator = currentProfile.role === 'collaborator';
    // Telefono combinado (codigo de pais + numero local) para la unica columna `phone_number`
    // de la base — no requiere migracion, el formato ya validado alcanza como texto.
    const phoneNumber = `${(phone_country_code as string ?? '').trim()}${(phone_local_number as string ?? '').trim()}`;

    const validationError = validateProfileInput(
      { first_name, last_name, phone_country_code, phone_local_number, agency_name, city, license_number },
      { requireLicenseNumber: !isCollaborator, requireAgencyName: !isCollaborator }
    );
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (isCollaborator) {
      // El colaborador no elige su inmobiliaria (el campo no llega en el body, ver whitelist) —
      // se hereda del dueño de la agencia al momento de guardar, nunca de lo que mande el
      // cliente (defensa en profundidad, mismo criterio que `country: 'Argentina'` más abajo).
      // `agency_owner_id` es NOT NULL en la práctica para `role='collaborator'` (siempre se
      // setea al invitar, ver adminPanelController.ts#inviteCollaborator) — el chequeo acá es
      // solo para satisfacer el tipo (`string | null` a nivel de columna), no un caso de negocio
      // esperado.
      const { data: ownerProfile, error: ownerFetchError } = currentProfile.agency_owner_id
        ? await supabase
            .from('profiles')
            .select('agency_name')
            .eq('id', currentProfile.agency_owner_id)
            .maybeSingle()
        : { data: null, error: null };
      if (ownerFetchError) throw ownerFetchError;

      const fullName = `${(first_name as string).trim()} ${(last_name as string).trim()}`.trim();
      const { data: profile, error } = await supabase
        .from('profiles')
        .update({
          full_name: fullName,
          phone_number: phoneNumber,
          agency_name: ownerProfile?.agency_name ?? null,
          city: (city as string).trim(),
          country: 'Argentina',
          // license_number/license_validation_status: no se tocan — un colaborador no pasa por
          // el flujo de validación de matrícula, opera bajo la del dueño de su agencia.
          profile_completed: true
        })
        .eq('id', tenantId)
        .select('id, full_name, email, phone_number, agency_name, city, country, profile_completed, license_number, license_validation_status, role, created_at')
        .single();

      if (error) throw error;

      return res.json({ success: true, profile });
    }

    // KAN-306: `license_validation_status` tiene `REVOKE UPDATE ... FROM authenticated` (migración
    // kan306_add_license_validation) — ningún tenant puede auto-asignarse 'validated' con su
    // cliente tenant-scoped, así que toda esta escritura pasa por el cliente service-role, no por
    // `req.supabaseClient` como el resto de las ediciones de perfil.
    const trimmedLicenseNumber = (license_number as string).trim();
    const validationStatus = await resolveLicenseValidationStatus(trimmedLicenseNumber);

    if (validationStatus === 'rejected') {
      const { error: rejectError } = await supabase
        .from('profiles')
        .update({ license_number: trimmedLicenseNumber, license_validation_status: 'rejected' })
        .eq('id', tenantId);
      if (rejectError) throw rejectError;

      logger.warn({ tenantId, licenseNumber: trimmedLicenseNumber }, '[PERFIL] Registro rechazado: número de matrícula no encontrado en el padrón (AC2).');
      return res.status(403).json({
        error: 'El número de matrícula ingresado no figura en el padrón de matriculados. Verificalo e intentá de nuevo.',
        license_validation_status: 'rejected'
      });
    }

    const fullName = `${(first_name as string).trim()} ${(last_name as string).trim()}`.trim();
    const isValidated = validationStatus === 'validated';

    const { data: profile, error } = await supabase
      .from('profiles')
      .update({
        full_name: fullName,
        phone_number: phoneNumber,
        agency_name: (agency_name as string).trim(),
        city: (city as string).trim(),
        country: 'Argentina',
        license_number: trimmedLicenseNumber,
        license_validation_status: validationStatus,
        // KAN-306 (AC5, registro temporal): mientras la matrícula esté 'pending' (padrón
        // desactualizado, no un rechazo real), profile_completed queda forzado en false — la
        // cuenta existe y puede loguearse, pero el resto de la app la trata como perfil
        // incompleto hasta que licenseValidationRetry.ts la valide en segundo plano.
        profile_completed: isValidated
      })
      .eq('id', tenantId)
      .select('id, full_name, email, phone_number, agency_name, city, country, profile_completed, license_number, license_validation_status, role, created_at')
      .single();

    if (error) throw error;

    if (validationStatus === 'pending') {
      logger.warn({ tenantId, licenseNumber: trimmedLicenseNumber }, '[PERFIL] Registro temporal (AC5): padrón de matriculados desactualizado, matrícula queda pendiente de validación.');
    }

    res.json({ success: true, profile });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[PERFIL] Error al actualizar el perfil del tenant');
    res.status(500).json({ error: 'Error interno al actualizar el perfil.' });
  }
}
