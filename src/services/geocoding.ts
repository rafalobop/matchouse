import { logger } from './logger';

// KAN-80: GeocodingService — resuelve lat/lng reales a partir de una dirección de texto.
// Proveedor elegido: Nominatim (OpenStreetMap), sin API key ni costo — no hay infraestructura de
// billing/API keys de terceros en el proyecto (ver src/config/env.ts) y la cartera es acotada a
// Tucumán, donde la cobertura de OSM es suficiente. Trade-off aceptado: política de uso de
// Nominatim limita a 1 request/seg, así que geocodificar un catálogo grande sin coordenadas
// puede tardar (ver limitación documentada en el comentario de syncPropertiesToDatabase).

export interface GeocodeSuccess {
  success: true;
  latitude: number;
  longitude: number;
}

export interface GeocodeFailure {
  success: false;
  reason: string;
}

export type GeocodeResult = GeocodeSuccess | GeocodeFailure;

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const GEOCODING_REQUEST_TIMEOUT_MS = 8000;
// Política de uso de Nominatim: máximo 1 request/seg. El gate es a nivel de módulo (no por
// llamada) para que valga sin importar cuántas propiedades se geocodifiquen en la misma corrida.
const MIN_REQUEST_INTERVAL_MS = 1100;

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

/** Solo para tests: evita que el throttle real (1.1s) frene la suite. */
export function __resetGeocodingThrottleForTests(): void {
  lastRequestAt = 0;
}

/**
 * Geocodifica una dirección de texto ya normalizada (ver utils/addressParser.ts) a coordenadas.
 * `fetchImpl` es inyectable (mismo patrón que el resto del repo con `client: SupabaseClient`)
 * para poder testear sin pegarle a la red real ni violar la política de uso de Nominatim.
 * Nunca lanza: los fallos de red/parseo/ausencia de resultados se devuelven como
 * `{ success: false, reason }`, quien llama decide qué hacer (típicamente: persistir null).
 */
export async function geocodeAddress(query: string, fetchImpl: typeof fetch = fetch): Promise<GeocodeResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    logger.warn('[GEOCODING] Consulta vacía, no se puede geocodificar');
    return { success: false, reason: 'Dirección vacía, no se puede geocodificar' };
  }

  await throttle();

  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'ar');

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), GEOCODING_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
      headers: {
        // Requerido por la política de uso de Nominatim: identificar la app que consulta.
        'User-Agent': 'Brokaza/1.0 (contacto: soporte@brokaza.com)'
      }
    });

    if (!response.ok) {
      logger.error({ query: trimmed, status: response.status }, '[GEOCODING] El servicio respondió con un estado HTTP no exitoso');
      return { success: false, reason: `El servicio de geocoding respondió con estado ${response.status}` };
    }

    const results = (await response.json()) as Array<{ lat: string; lon: string }>;
    if (!results || results.length === 0) {
      logger.warn({ query: trimmed }, '[GEOCODING] Sin resultados para la dirección consultada');
      return { success: false, reason: 'No se encontraron coordenadas para la dirección' };
    }

    const latitude = parseFloat(results[0].lat);
    const longitude = parseFloat(results[0].lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      logger.error({ query: trimmed, raw: results[0] }, '[GEOCODING] El servicio devolvió coordenadas no numéricas');
      return { success: false, reason: 'Coordenadas inválidas devueltas por el servicio de geocoding' };
    }

    logger.info({ query: trimmed, latitude, longitude }, '[GEOCODING] Dirección geocodificada correctamente');
    return { success: true, latitude, longitude };
  } catch (error: any) {
    const isTimeout = error?.name === 'AbortError';
    const reason = isTimeout
      ? 'Tiempo de espera agotado al consultar el servicio de geocoding'
      : `Error de red al consultar el servicio de geocoding: ${error?.message ?? String(error)}`;
    logger.error({ query: trimmed, error: error?.message ?? String(error), timeout: isTimeout }, '[GEOCODING] Fallo al geocodificar la dirección');
    return { success: false, reason };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
