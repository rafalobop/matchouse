import { ExtractedRealEstateRequest, ZoneIntentRequest } from '../services/gemini';
import { Property } from '../services/sheets';
import { zones } from './constants/zones';

export interface MatchResult {
  isMatch: boolean;
  score: number; // 0 a 100 indicando qué tan bueno es el match
  reasons: string[];
}

const COTIZACION_DOLAR_BLUE = 1200;

/**
 * Ray-casting algorithm for Point-in-Polygon detection
 */
function isPointInPolygon(latitude: number, longitude: number, polygon: number[][]): boolean {
  let inside = false;
  const x = longitude;
  const y = latitude;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    
    const intersect = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Clasifica de manera local el domicilio y características de una propiedad en un zona_id
 */
export function classifyPropertyZoneId(property: Property): string {
  // 1. Si la propiedad tiene coordenadas, verificar si entra en el polígono de alguna zona
  if (property.latitud !== undefined && property.longitud !== undefined && property.latitud !== 0 && property.longitud !== 0) {
    for (const [zoneId, zoneData] of Object.entries(zones)) {
      if (zoneData.coordinates && isPointInPolygon(property.latitud, property.longitud, zoneData.coordinates)) {
        return zoneId;
      }
    }
  }

  // 2. Fallback: clasificar por palabras clave en dirección/descripción
  const text = `${property.domicilio} ${property.caracteristicas} ${property.sheetName} ${property.zona}`.toLowerCase();

  if (text.includes('mate de luna') || text.includes('parque avellaneda')) {
    return 'ZONA_MATE_DE_LUNA';
  }
  if (
    text.includes('yerba buena') ||
    text.includes('aconquija') ||
    text.includes('peron') ||
    text.includes('perón') ||
    text.includes('yb') ||
    text.includes('las arboledas') ||
    text.includes('san patricio') ||
    text.includes('las cañas') ||
    text.includes('san pablo') ||
    text.includes('la arboleda')
  ) {
    return 'YERBA_BUENA';
  }
  if (text.includes('nogales')) {
    return 'ZONA_LOS_NOGALES';
  }
  if (text.includes('tafi viejo') || text.includes('tafí viejo')) {
    return 'ZONA_TAFI_VIEJO';
  }
  if (text.includes('lomas de tafi') || text.includes('lomas de tafí')) {
    return 'ZONA_LOMAS_DE_TAFI';
  }
  if (text.includes('sur') || text.includes('barrio sur') || text.includes('b° sur')) {
    return 'BARRIO_SUR';
  }
  if (text.includes('norte') || text.includes('barrio norte') || text.includes('b° norte')) {
    return 'BARRIO_NORTE';
  }

  // Calles céntricas y de Barrio Norte comunes en SMT
  const centroKeywords = [
    'santiago',
    'corrientes',
    'laprida',
    'balcarce',
    'muñecas',
    'maipu',
    'maipú',
    '25 de mayo',
    'santa fe',
    'san martin',
    'san martín',
    'centro'
  ];

  if (centroKeywords.some(keyword => text.includes(keyword))) {
    if (text.includes('9 de julio') || text.includes('congreso') || text.includes('las heras') || text.includes('ayacucho')) {
      return 'ZONA_CENTRO';
    }
    return 'BARRIO_NORTE';
  }

  return 'DESCONOCIDO';
}

/**
 * Compara un pedido de cliente con una propiedad de la cartera
 */
export function checkMatch(
  request: ExtractedRealEstateRequest,
  property: Property,
  zoneIntent?: ZoneIntentRequest
): MatchResult {
  const reasons: string[] = [];
  let score = 100;

  // 1. Validar por el Agente 2 (Geolocalización Inexacta / Intenciones) si existe
  if (zoneIntent && zoneIntent.zona_id !== 'DESCONOCIDO') {
    const propZoneId = classifyPropertyZoneId(property);
    if (propZoneId !== zoneIntent.zona_id) {
      return {
        isMatch: false,
        score: 0,
        reasons: [`Zona de la propiedad (${propZoneId}) no coincide con la zona del pedido (${zoneIntent.zona_id})`]
      };
    }
    reasons.push(`Coincidencia de Zona Geográfica: ${zoneIntent.zona_id}`);
  }

  // 2. Filtrar por Operación (Venta / Alquiler)
  const operacionRequest = (zoneIntent && zoneIntent.operacion !== 'DESCONOCIDO')
    ? (zoneIntent.operacion === 'COMPRA' ? 'venta' : 'alquiler')
    : request.operacion;

  if (operacionRequest !== 'desconocido' && operacionRequest !== property.operacion) {
    return { isMatch: false, score: 0, reasons: ['Diferente tipo de operación'] };
  }

  // 3. Tipo de Propiedad
  if (request.tipo_propiedad !== 'otro' && request.tipo_propiedad !== property.tipo_propiedad) {
    return { isMatch: false, score: 0, reasons: ['Diferente tipo de propiedad'] };
  }

  // 4. Zona de Ubicación General (Si no se usó el Agente 2 para geo-filtrado específico)
  if ((!zoneIntent || zoneIntent.zona_id === 'DESCONOCIDO') && request.zonas.length > 0) {
    const zoneMatch = request.zonas.some(zonaReq =>
      zonaReq.toLowerCase() === property.zona.toLowerCase()
    );
    if (!zoneMatch) {
      return { isMatch: false, score: 0, reasons: [`Zona de la propiedad (${property.zona}) no solicitada en: ${request.zonas.join(', ')}`] };
    }
  }

  // 5. Cantidad de Dormitorios (Validando mínimos del Agente 2 o valor del Agente 1)
  const dormitoriosRequeridos = (zoneIntent && zoneIntent.dormitorios_min !== null)
    ? zoneIntent.dormitorios_min
    : request.dormitorios;

  if (dormitoriosRequeridos !== null) {
    if (property.dormitorios < dormitoriosRequeridos) {
      return { isMatch: false, score: 0, reasons: [`Faltan dormitorios (pide mínimo ${dormitoriosRequeridos}, tiene ${property.dormitorios})`] };
    }
    if (property.dormitorios > dormitoriosRequeridos) {
      score -= 10; // Penalización menor por tener más dormitorios de lo pedido
      reasons.push(`Tiene más dormitorios de lo requerido (pide ${dormitoriosRequeridos}, tiene ${property.dormitorios})`);
    }
  }

  // 6. Presupuesto Máximo y Precio
  if (request.presupuesto_max !== null && property.precio > 0) {
    let precioPropiedadEnMonedaReq = property.precio;

    if (request.moneda !== 'desconocido' && request.moneda !== property.moneda) {
      if (request.moneda === 'USD' && property.moneda === 'ARS') {
        precioPropiedadEnMonedaReq = property.precio / COTIZACION_DOLAR_BLUE;
        reasons.push(`Conversión de moneda: propiedad en ARS convertida a USD usando tasa ref $${COTIZACION_DOLAR_BLUE}`);
      } else if (request.moneda === 'ARS' && property.moneda === 'USD') {
        precioPropiedadEnMonedaReq = property.precio * COTIZACION_DOLAR_BLUE;
        reasons.push(`Conversión de moneda: propiedad en USD convertida a ARS usando tasa ref $${COTIZACION_DOLAR_BLUE}`);
      }
    }

    const margenTolerancia = request.presupuesto_max * 1.05;
    if (precioPropiedadEnMonedaReq > margenTolerancia) {
      return {
        isMatch: false,
        score: 0,
        reasons: [`El precio (${property.moneda} ${property.precio}) excede el presupuesto máximo (${request.moneda} ${request.presupuesto_max})`]
      };
    }

    if (precioPropiedadEnMonedaReq > request.presupuesto_max) {
      score -= 10;
      reasons.push(`El precio excede levemente el presupuesto (dentro del 5% de margen de negociación)`);
    }
  }

  // 7. Características Clave (Combinando listados de ambos agentes)
  const featuresRequeridas = Array.from(new Set([
    ...request.caracteristicas_clave,
    ...(zoneIntent?.caracteristicas_claves || [])
  ]));

  if (featuresRequeridas.length > 0 && property.caracteristicas) {
    const descLower = property.caracteristicas.toLowerCase();
    const matchingFeatures: string[] = [];
    const missingFeatures: string[] = [];

    featuresRequeridas.forEach(feat => {
      let matches = false;
      const featLower = feat.toLowerCase();
      if (featLower === 'cochera') {
        matches = descLower.includes('cochera') || descLower.includes('coch') || descLower.includes('garaje') || descLower.includes('garage');
      } else if (featLower === 'pileta') {
        matches = descLower.includes('pileta') || descLower.includes('piscina') || descLower.includes('pisc');
      } else if (featLower === 'jardin') {
        matches = descLower.includes('jard') || descLower.includes('patio') || descLower.includes('verde');
      } else {
        matches = descLower.includes(featLower);
      }

      if (matches) {
        matchingFeatures.push(feat);
      } else {
        missingFeatures.push(feat);
      }
    });

    if (matchingFeatures.length > 0) {
      reasons.push(`Características que coinciden: ${matchingFeatures.join(', ')}`);
      const ratio = matchingFeatures.length / featuresRequeridas.length;
      score = Math.round(score * (0.8 + 0.2 * ratio));
    }

    if (missingFeatures.length > 0) {
      reasons.push(`Características faltantes: ${missingFeatures.join(', ')}`);
      score -= (missingFeatures.length * 5);
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    isMatch: true,
    score,
    reasons
  };
}
