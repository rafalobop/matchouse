import { ExtractedRealEstateRequest, ZoneIntentRequest } from '../services/ai';
import { Property } from '../services/sheets';
import { zones } from './constants/zones';

export interface MatchResult {
  isMatch: boolean;
  score: number;
  reasons: string[];
}

export interface MatchingResult {
  isMatch: boolean;
  scoreDeduction: number;
  reason?: string;
}

export interface IMatchingStrategy {
  name: string;
  evaluate(
    request: ExtractedRealEstateRequest,
    property: Property,
    zoneIntent?: ZoneIntentRequest
  ): MatchingResult;
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
  if (property.latitud !== undefined && property.longitud !== undefined && property.latitud !== 0 && property.longitud !== 0) {
    for (const [zoneId, zoneData] of Object.entries(zones)) {
      if (zoneData.coordinates && isPointInPolygon(property.latitud, property.longitud, zoneData.coordinates)) {
        return zoneId;
      }
    }
  }

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
 * Determina si una propiedad está ubicada dentro de un country o barrio cerrado/privado
 */
export function isPropertyInCountry(property: Property): boolean {
  const text = `${property.domicilio} ${property.caracteristicas} ${property.pisoLote} ${property.sheetName}`.toLowerCase();

  const countryKeywords = [
    'country',
    'barrio cerrado',
    'barrio privado',
    'b° cerrado',
    'b° privado',
    'club de campo',
    'las yungas',
    'las cañas',
    'la arboleda',
    'alto verde',
    'valle escondido',
    'cerro azul',
    'lomas de tafi'
  ];

  return countryKeywords.some(keyword => text.includes(keyword));
}

// --- IMPLEMENTACIÓN DE ESTRATEGIAS DE MATCHING ---

export class OperationMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Operación';

  evaluate(request: ExtractedRealEstateRequest, property: Property, zoneIntent?: ZoneIntentRequest): MatchingResult {
    const operacionRequest = (zoneIntent && zoneIntent.operacion !== 'DESCONOCIDO')
      ? (zoneIntent.operacion === 'COMPRA' ? 'venta' : 'alquiler')
      : request.operacion;

    if (operacionRequest !== 'desconocido' && operacionRequest !== property.operacion) {
      return { isMatch: false, scoreDeduction: 0, reason: 'Diferente tipo de operación' };
    }
    return { isMatch: true, scoreDeduction: 0 };
  }
}

export class PropertyTypeMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Tipo de Propiedad';

  evaluate(request: ExtractedRealEstateRequest, property: Property): MatchingResult {
    if (request.tipo_propiedad !== 'otro' && request.tipo_propiedad !== property.tipo_propiedad) {
      return { isMatch: false, scoreDeduction: 0, reason: 'Diferente tipo de propiedad' };
    }
    return { isMatch: true, scoreDeduction: 0 };
  }
}

export class CountryMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Country';

  evaluate(request: ExtractedRealEstateRequest, property: Property): MatchingResult {
    if (request.country && request.country !== 'indiferente') {
      const propInCountry = isPropertyInCountry(property);
      if (request.country === 'si' && !propInCountry) {
        return { isMatch: false, scoreDeduction: 0, reason: 'El pedido requiere country/barrio cerrado y la propiedad no está en uno.' };
      }
      if (request.country === 'no' && propInCountry) {
        return { isMatch: false, scoreDeduction: 0, reason: 'El pedido excluye countries/barrios cerrados y la propiedad está en uno.' };
      }
      return {
        isMatch: true,
        scoreDeduction: 0,
        reason: request.country === 'si'
          ? 'Propiedad en country/barrio cerrado como fue requerido'
          : 'Propiedad fuera de country/barrio cerrado como fue requerido'
      };
    }
    return { isMatch: true, scoreDeduction: 0 };
  }
}

export class ZoneMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Zona';

  evaluate(request: ExtractedRealEstateRequest, property: Property, zoneIntent?: ZoneIntentRequest): MatchingResult {
    // 1. Validar por el Agente 2 (Geolocalización Inexacta / Intenciones) si existe
    if (zoneIntent && zoneIntent.zona_id !== 'DESCONOCIDO') {
      const propZoneId = classifyPropertyZoneId(property);
      if (propZoneId !== zoneIntent.zona_id) {
        return {
          isMatch: false,
          scoreDeduction: 0,
          reason: `Zona de la propiedad (${propZoneId}) no coincide con la zona del pedido (${zoneIntent.zona_id})`
        };
      }
      return { isMatch: true, scoreDeduction: 0, reason: `Coincidencia de Zona Geográfica: ${zoneIntent.zona_id}` };
    }

    // 2. Zona de Ubicación General (Si no se usó el Agente 2 para geo-filtrado específico)
    if (request.zonas.length > 0) {
      const zoneMatch = request.zonas.some(zonaReq =>
        zonaReq.toLowerCase() === property.zona.toLowerCase()
      );
      if (!zoneMatch) {
        return {
          isMatch: false,
          scoreDeduction: 0,
          reason: `Zona de la propiedad (${property.zona}) no solicitada en: ${request.zonas.join(', ')}`
        };
      }
    }

    return { isMatch: true, scoreDeduction: 0 };
  }
}

export class BedroomsMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Dormitorios';

  evaluate(request: ExtractedRealEstateRequest, property: Property, zoneIntent?: ZoneIntentRequest): MatchingResult {
    const bedroomsRequired = (zoneIntent && zoneIntent.dormitorios_min !== null)
      ? zoneIntent.dormitorios_min
      : request.dormitorios;

    if (bedroomsRequired !== null) {
      if (property.dormitorios < bedroomsRequired) {
        return {
          isMatch: false,
          scoreDeduction: 0,
          reason: `Faltan dormitorios (pide mínimo ${bedroomsRequired}, tiene ${property.dormitorios})`
        };
      }
      if (property.dormitorios > bedroomsRequired) {
        return {
          isMatch: true,
          scoreDeduction: 10,
          reason: `Tiene más dormitorios de lo requerido (pide ${bedroomsRequired}, tiene ${property.dormitorios})`
        };
      }
    }
    return { isMatch: true, scoreDeduction: 0 };
  }
}

export class BudgetMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Presupuesto';

  evaluate(request: ExtractedRealEstateRequest, property: Property): MatchingResult {
    if (request.presupuesto_max !== null && property.precio > 0) {
      let propertyPriceInReqCurrency = property.precio;
      let conversionReason = '';

      if (request.moneda !== 'desconocido' && request.moneda !== property.moneda) {
        if (request.moneda === 'USD' && property.moneda === 'ARS') {
          propertyPriceInReqCurrency = property.precio / COTIZACION_DOLAR_BLUE;
          conversionReason = `Conversión de moneda: propiedad en ARS convertida a USD usando tasa ref $${COTIZACION_DOLAR_BLUE}`;
        } else if (request.moneda === 'ARS' && property.moneda === 'USD') {
          propertyPriceInReqCurrency = property.precio * COTIZACION_DOLAR_BLUE;
          conversionReason = `Conversión de moneda: propiedad en USD convertida a ARS usando tasa ref $${COTIZACION_DOLAR_BLUE}`;
        }
      }

      const toleranceLimit = request.presupuesto_max * 1.05;
      if (propertyPriceInReqCurrency > toleranceLimit) {
        return {
          isMatch: false,
          scoreDeduction: 0,
          reason: `El precio (${property.moneda} ${property.precio}) excede el presupuesto máximo (${request.moneda} ${request.presupuesto_max})`
        };
      }

      if (propertyPriceInReqCurrency > request.presupuesto_max) {
        return {
          isMatch: true,
          scoreDeduction: 10,
          reason: [
            conversionReason,
            'El precio excede levemente el presupuesto (dentro del 5% de margen de negociación)'
          ].filter(Boolean).join('. ')
        };
      }

      if (conversionReason) {
        return { isMatch: true, scoreDeduction: 0, reason: conversionReason };
      }
    }
    return { isMatch: true, scoreDeduction: 0 };
  }
}

export class FeaturesMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Características';

  evaluate(request: ExtractedRealEstateRequest, property: Property, zoneIntent?: ZoneIntentRequest): MatchingResult {
    const requiredFeatures = Array.from(new Set([
      ...request.caracteristicas_clave,
      ...(zoneIntent?.caracteristicas_claves || [])
    ]));

    if (requiredFeatures.length > 0 && property.caracteristicas) {
      const descLower = property.caracteristicas.toLowerCase();
      const matchingFeatures: string[] = [];
      const missingFeatures: string[] = [];

      requiredFeatures.forEach(feat => {
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

      let scoreDeduction = 0;
      const reasons: string[] = [];

      if (matchingFeatures.length > 0) {
        reasons.push(`Características que coinciden: ${matchingFeatures.join(', ')}`);
        const ratio = matchingFeatures.length / requiredFeatures.length;
        // La fórmula original era: score = Math.round(score * (0.8 + 0.2 * ratio))
        // Esto equivale a una deducción proporcional sobre 100 puntos.
        // Si score era 100: deduction = 100 - Math.round(100 * (0.8 + 0.2 * ratio))
        scoreDeduction += (100 - Math.round(100 * (0.8 + 0.2 * ratio)));
      } else {
        // Si no coincide ninguna, score * 0.8
        scoreDeduction += 20;
      }

      if (missingFeatures.length > 0) {
        reasons.push(`Características faltantes: ${missingFeatures.join(', ')}`);
        scoreDeduction += (missingFeatures.length * 5);
      }

      return {
        isMatch: true,
        scoreDeduction,
        reason: reasons.join('. ')
      };
    }

    return { isMatch: true, scoreDeduction: 0 };
  }
}

// Registramos todas las estrategias que se ejecutarán en orden secuencial
const matchingStrategies: IMatchingStrategy[] = [
  new OperationMatchingStrategy(),
  new PropertyTypeMatchingStrategy(),
  new CountryMatchingStrategy(),
  new ZoneMatchingStrategy(),
  new BedroomsMatchingStrategy(),
  new BudgetMatchingStrategy(),
  new FeaturesMatchingStrategy()
];

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

  for (const strategy of matchingStrategies) {
    const result = strategy.evaluate(request, property, zoneIntent);

    if (!result.isMatch) {
      return {
        isMatch: false,
        score: 0,
        reasons: [result.reason || `Descartado por ${strategy.name}`]
      };
    }

    if (result.scoreDeduction > 0) {
      score -= result.scoreDeduction;
    }
    if (result.reason) {
      reasons.push(result.reason);
    }
  }

  return {
    isMatch: true,
    score: Math.max(0, Math.min(100, score)),
    reasons
  };
}
