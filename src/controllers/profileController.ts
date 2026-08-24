import * as express from 'express';
import { getTucumanLocalities } from '../services/localitiesService';
import { logger } from '../services/logger';
import { validateProfileInput } from '../utils/profileValidation';

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
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;

  try {
    const { data: profile, error } = await tenantSupabase
      .from('profiles')
      .select('id, full_name, email, phone_number, agency_name, city, country, profile_completed, created_at')
      .eq('id', tenantId)
      .single();

    if (error) throw error;

    res.json({ profile });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[PERFIL] Error al obtener el perfil del tenant');
    res.status(500).json({ error: error.message || 'Error interno al obtener el perfil.' });
  }
}

export async function updateProfile(req: express.Request, res: express.Response) {
  const tenantId = (req as any).tenantId;
  const tenantSupabase = (req as any).supabaseClient;
  // KAN-90: first_name/last_name no tienen columnas propias en `profiles` (solo existe
  // `full_name`, un campo combinado desde SPEC-0012) — se piden separados en el formulario para
  // que queden marcados como dos campos obligatorios distintos (AC1), y acá se combinan en
  // `full_name` al persistir, sin necesidad de una migración de schema para este fix.
  // KAN-93: `country` ya NO se acepta del cliente — el negocio fija Argentina como único país
  // habilitado hasta tener un producto local sólido (decisión documentada en .agent/CONTEXT.md),
  // así que se hardcodea acá en vez de confiar en lo que mande el body (defensa en profundidad,
  // ni un payload manipulado puede setear otro país).
  const { first_name, last_name, phone_number, agency_name, city } = req.body;

  const validationError = validateProfileInput({ first_name, last_name, phone_number, agency_name, city });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const fullName = `${(first_name as string).trim()} ${(last_name as string).trim()}`.trim();
    const { data: profile, error } = await tenantSupabase
      .from('profiles')
      .update({
        full_name: fullName,
        phone_number: (phone_number as string).trim(),
        agency_name: (agency_name as string).trim(),
        city: (city as string).trim(),
        country: 'Argentina',
        profile_completed: true
      })
      .eq('id', tenantId)
      .select('id, full_name, email, phone_number, agency_name, city, country, profile_completed, created_at')
      .single();

    if (error) throw error;

    res.json({ success: true, profile });
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[PERFIL] Error al actualizar el perfil del tenant');
    res.status(500).json({ error: error.message || 'Error interno al actualizar el perfil.' });
  }
}
