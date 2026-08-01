import { logger } from './logger';

// KAN-93: localidades reales de la provincia de Tucumán para el combobox de "Ciudad" del
// formulario de perfil (POST /api/profile). Alcance geográfico deliberadamente fijo — el
// negocio no permite otro país/provincia hasta tener un producto local sólido (decisión del
// usuario, ver .agent/CONTEXT.md), así que esta es la ÚNICA fuente de "ciudad" posible, nunca un
// combobox libre de país/provincia. Proveedor: API Georef (datos.gob.ar), pública, sin API key,
// mantenida por el Estado argentino — mismo criterio de "sin infraestructura de billing de
// terceros" ya usado en geocoding.ts (Nominatim) y dolar.ts (DolarAPI).

const GEOREF_LOCALIDADES_URL = 'https://apis.datos.gob.ar/georef/api/localidades';
const REQUEST_TIMEOUT_MS = 8000;
// Las localidades de una provincia prácticamente no cambian — TTL largo, sin necesidad del
// patrón de refresco periódico en background que sí tiene sentido para un valor que fluctúa
// (dolar.ts). Se resuelve on-demand, la primera vez que alguien pide el formulario de perfil.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Fallback si la API de Georef no responde (caída puntual, timeout, etc.) — nunca dejar el
// combobox vacío/bloqueado por una dependencia externa. Lista curada de las localidades más
// pobladas/conocidas de Tucumán (no pretende ser exhaustiva, es un piso razonable).
export const TUCUMAN_LOCALITIES_FALLBACK: string[] = [
  'San Miguel de Tucumán',
  'Yerba Buena',
  'Tafí Viejo',
  'Banda del Río Salí',
  'Alderetes',
  'Concepción',
  'Aguilares',
  'Famaillá',
  'Monteros',
  'Lules',
  'Bella Vista',
  'Simoca',
  'Trancas',
  'Tafí del Valle',
  'Delfín Gallo'
].sort((a, b) => a.localeCompare(b, 'es'));

interface LocalitiesCache {
  entries: string[];
  expiresAt: number;
}

let cache: LocalitiesCache | null = null;

/** Solo para tests: fuerza a que la próxima llamada vuelva a consultar la API (o el fetchImpl inyectado). */
export function __clearTucumanLocalitiesCacheForTests(): void {
  cache = null;
}

/**
 * Devuelve el listado de localidades reales de Tucumán, ordenado alfabéticamente y sin
 * duplicados. `fetchImpl` inyectable (mismo patrón que geocoding.ts) para testear sin red real.
 * Nunca lanza: ante cualquier fallo (red, timeout, respuesta inesperada) cae a
 * `TUCUMAN_LOCALITIES_FALLBACK` sin cachear ese resultado, para reintentar la API real la
 * próxima vez en vez de quedar pegado al fallback.
 */
export async function getTucumanLocalities(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.entries;
  }

  const url = new URL(GEOREF_LOCALIDADES_URL);
  url.searchParams.set('provincia', 'tucuman');
  url.searchParams.set('campos', 'nombre');
  url.searchParams.set('max', '400');

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url.toString(), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as { localidades?: Array<{ nombre?: string }> };
    const names = (data.localidades ?? [])
      // Georef a veces devuelve el nombre de una "localidad compuesta" con el departamento como
      // sufijo (ej. "Yerba Buena - Marcos Paz") para desambiguar en su propio dataset — nos
      // quedamos con la primera parte, el nombre colloquial real que la gente conoce y usa
      // ("Yerba Buena"). Solo afecta a un puñado de localidades de Tucumán (5 de 109 a la fecha).
      .map((l) => l.nombre?.split(' - ')[0]?.trim())
      .filter((n): n is string => !!n);

    const unique = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b, 'es'));
    if (unique.length === 0) {
      throw new Error('Respuesta de Georef sin localidades');
    }

    cache = { entries: unique, expiresAt: Date.now() + CACHE_TTL_MS };
    logger.info({ count: unique.length }, '[LOCALITIES] Localidades de Tucumán cargadas desde Georef.');
    return unique;
  } catch (error: any) {
    const isTimeout = error?.name === 'AbortError';
    logger.warn(
      { error: error?.message ?? String(error), timeout: isTimeout },
      '[LOCALITIES] No se pudo consultar Georef, se usa el listado de respaldo.'
    );
    return TUCUMAN_LOCALITIES_FALLBACK;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
