// KAN-306: sincronización del padrón de matriculados del Colegio de Corredores Inmobiliarios de
// Tucumán (CCIT) — https://ccit.com.ar/padron/ no expone API, es una tabla HTML estática (~420
// filas, sin paginación, generada por el plugin "Ninja Tables" de WordPress; confirmado por
// inspección real de la página). En vez de pegarle a esa URL en cada registro (frágil, lento, sin
// garantía de disponibilidad), se sincroniza periódicamente a `licensed_agents` (caché local,
// solo accesible server-side — ver migración kan306_add_license_validation) y la validación de
// matrícula en el registro consulta esa tabla local.

import { supabase } from './supabase';
import { logger } from './logger';
import { config } from '../config/env';

export interface LicensedAgentRecord {
  licenseNumber: string;
  agencyName: string;
  brokerName: string;
  cuit: string;
  address: string;
  phones: string;
  email: string;
}

export type LicenseValidationStatus = 'validated' | 'pending' | 'rejected';

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

const ROW_REGEX = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const CELL_REGEX = /<td[^>]*>([\s\S]*?)<\/td>/g;
const TAG_STRIP_REGEX = /<[^>]*>/g;
const LICENSE_NUMBER_CELL_REGEX = /^\d+$/;

function cleanCell(raw: string): string {
  return decodeHtmlEntities(raw.replace(TAG_STRIP_REGEX, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parser puro (sin acceso a red) del HTML del padrón — separado por el mismo motivo que
 * excelHeaderMatcher.ts: testeable con fixtures sin depender de la red real. Orden de columnas
 * fijo, confirmado por inspección real del `<thead>` de la página: INMOBILIARIA, MAT, CORREDOR -
 * INMOBILIARIO, C.U.I.T., DIRECCION, TELEFONOS, MAIL. Filas cuya columna de matrícula no es
 * puramente numérica se descartan (fila de encabezado, separador, fila rota).
 */
export function parsePadronHtml(html: string): LicensedAgentRecord[] {
  const records: LicensedAgentRecord[] = [];
  const rowMatches = html.match(ROW_REGEX) || [];

  for (const rowHtml of rowMatches) {
    const cells: string[] = [];
    CELL_REGEX.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = CELL_REGEX.exec(rowHtml)) !== null) {
      cells.push(cleanCell(cellMatch[1]));
    }
    if (cells.length < 7) continue;

    const [agencyName, licenseNumber, brokerName, cuit, address, phones, email] = cells;
    if (!LICENSE_NUMBER_CELL_REGEX.test(licenseNumber)) continue;

    records.push({ licenseNumber, agencyName, brokerName, cuit, address, phones, email });
  }

  return records;
}

const PADRON_FETCH_TIMEOUT_MS = 15_000;

/** Descarga el HTML del padrón. `fetchImpl` inyectable (mismo patrón que geocoding.ts/localitiesService.ts). */
export async function fetchPadronHtml(fetchImpl: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), PADRON_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(config.licensePadronUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Sincroniza `licensed_agents` con el padrón real: upsert por `license_number` con `synced_at` de
 * esta corrida, y borra las filas que no aparecieron en esta corrida (mismo criterio de
 * "Sincronización Atómica" que la carga de propiedades vía Excel — ver .agent/CONTEXT.md sección
 * 4 — para que un agente que perdió la matrícula no quede validado para siempre). Nunca lanza:
 * ante cualquier fallo de red/parseo, loguea y devuelve `false` — `licensed_agents` queda como
 * estaba tras la última corrida exitosa (o vacía si nunca corrió una), que es justamente la señal
 * de "padrón desactualizado" que usa `resolveLicenseValidationStatus` para caer a `'pending'`.
 */
export async function syncLicensedAgents(client = supabase, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const html = await fetchPadronHtml(fetchImpl);
    const records = parsePadronHtml(html);
    if (records.length === 0) {
      throw new Error('El padrón no devolvió ninguna fila válida (posible cambio de estructura de la página).');
    }

    const syncedAt = new Date().toISOString();
    const { error: upsertError } = await client
      .from('licensed_agents')
      .upsert(
        records.map((r) => ({
          license_number: r.licenseNumber,
          agency_name: r.agencyName,
          broker_name: r.brokerName,
          cuit: r.cuit,
          address: r.address,
          phones: r.phones,
          email: r.email,
          synced_at: syncedAt
        })),
        { onConflict: 'license_number' }
      );
    if (upsertError) throw upsertError;

    const { error: deleteStaleError } = await client
      .from('licensed_agents')
      .delete()
      .lt('synced_at', syncedAt);
    if (deleteStaleError) throw deleteStaleError;

    logger.info({ count: records.length }, '[LICENSE-REGISTRY] Padrón de matriculados sincronizado.');
    return true;
  } catch (error: any) {
    logger.error({ error: error.message || error }, '[LICENSE-REGISTRY] No se pudo sincronizar el padrón de matriculados.');
    return false;
  }
}

/**
 * Determina el estado de validación de una matrícula contra la caché local. `'pending'` cuando la
 * caché está vacía o más vieja que `config.licenseDataStaleHours` (padrón nunca sincronizado, o la
 * fuente externa lleva caída más de ese umbral) — adaptación del AC original ("registro temporal
 * si la API externa está caída") al hecho de que la fuente real es un scraping periódico, no un
 * endpoint por request. Nunca lanza: ante un error de DB al chequear, degrada a `'pending'`
 * (fail-safe hacia el registro temporal, nunca hacia un rechazo falso).
 */
export async function resolveLicenseValidationStatus(
  licenseNumber: string,
  client = supabase
): Promise<LicenseValidationStatus> {
  const { data: freshest, error: freshestError } = await client
    .from('licensed_agents')
    .select('synced_at')
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (freshestError) {
    logger.error({ error: freshestError.message }, '[LICENSE-REGISTRY] Error al chequear la antigüedad del padrón.');
    return 'pending';
  }

  const staleThresholdMs = config.licenseDataStaleHours * 60 * 60 * 1000;
  const isStale = !freshest || (Date.now() - new Date(freshest.synced_at as string).getTime()) > staleThresholdMs;
  if (isStale) {
    return 'pending';
  }

  const { data: match, error: matchError } = await client
    .from('licensed_agents')
    .select('license_number')
    .eq('license_number', licenseNumber)
    .maybeSingle();

  if (matchError) {
    logger.error({ error: matchError.message, licenseNumber }, '[LICENSE-REGISTRY] Error al validar la matrícula.');
    return 'pending';
  }

  return match ? 'validated' : 'rejected';
}
