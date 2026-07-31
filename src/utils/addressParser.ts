// KAN-80: normaliza el campo `address` (domicilio) de una propiedad a una consulta apta para un
// geocoder de calles, manejando los patrones de domicilio complejo que aparecen en la cartera
// real de Tucumán: sin número ("s/n"), rutas/kilómetros ("Ruta 9 Km 12"), e intersecciones
// ("Av. Aconquija y Av. Perón" / "esq. Balcarce"). Función pura, sin acceso a red, para poder
// testearla sin mockear el servicio de geocoding.

const NO_NUMBER_PATTERN = /\bs\/?n\b\.?/gi;
const ROUTE_PATTERN = /\b(?:ruta|rp|r\.p\.?)\s*\.?\s*\d+\b|\bkm\.?\s*\d+([.,]\d+)?\b/i;
const INTERSECTION_PATTERN = /^(.*?)\s+(?:esq\.?|esquina)\s+.+$/i;
const INTERSECTION_Y_PATTERN = /^(.+?\d.*?)\s+(?:y|\/)\s+.+$/i;

export interface ParsedAddress {
  /** Consulta lista para mandar al geocoder (calle limpia + contexto de zona/localidad). */
  normalized: string;
  /** false para domicilios "s/n" — no hay número de puerta que geocodificar con precisión. */
  hasStreetNumber: boolean;
  /** true para domicilios sobre ruta/kilómetro (rural/terreno), útil para logging/diagnóstico. */
  isRouteAddress: boolean;
}

/**
 * Limpia el domicilio crudo de una propiedad y arma la consulta que se le manda al geocoder,
 * agregando contexto de zona/localidad para desambiguar (todas las propiedades de la cartera
 * son de Tucumán, Argentina). No hace red ni valida contra ningún servicio externo.
 */
export function buildGeocodableQuery(property: { address: string; zone_display_name?: string }): ParsedAddress {
  let street = property.address.replace(/\s+/g, ' ').trim();

  const isRouteAddress = ROUTE_PATTERN.test(street);
  const hasStreetNumber = !NO_NUMBER_PATTERN.test(street) && /\d/.test(street);

  // "s/n": no aporta nada a un geocoder de calles, y confunde la búsqueda si se manda tal cual.
  street = street.replace(NO_NUMBER_PATTERN, '').replace(/\s+/g, ' ').trim();

  // Intersecciones ("Av. X esq. Av. Y", "Av. X y Av. Y"): Nominatim no resuelve cruces de calles
  // de forma confiable, así que nos quedamos con la primera vía nombrada como mejor esfuerzo.
  const intersectionMatch = street.match(INTERSECTION_PATTERN) ?? street.match(INTERSECTION_Y_PATTERN);
  if (intersectionMatch) {
    street = intersectionMatch[1].trim();
  }

  const contextParts = [street, property.zone_display_name, 'Tucumán', 'Argentina']
    .map(part => part?.trim())
    .filter((part): part is string => !!part);

  return {
    normalized: contextParts.join(', '),
    hasStreetNumber,
    isRouteAddress
  };
}
