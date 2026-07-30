import { ExtractedRealEstateRequest, ZoneIntentRequest } from '../services/ai';
import { Property } from '../services/excel';
import { getDolarBlueRate } from '../services/dolar';

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



function getPisoLoteText(p: Pick<Property, 'floor' | 'unit' | 'block' | 'lot'>): string {
  return [p.floor, p.unit, p.block, p.lot].filter(Boolean).join(' ');
}

/**
 * Determina si una propiedad está ubicada dentro de un country o barrio cerrado/privado
 */
export function isPropertyInCountry(property: Property): boolean {
  const text = `${property.address} ${property.features ?? ''} ${getPisoLoteText(property)} ${property.sheet_name}`.toLowerCase();

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
      : request.operation;

    if (operacionRequest !== 'desconocido' && operacionRequest !== property.operation) {
      return { isMatch: false, scoreDeduction: 0, reason: 'Diferente tipo de operación' };
    }
    return { isMatch: true, scoreDeduction: 0 };
  }
}

export class PropertyTypeMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Tipo de Propiedad';

  evaluate(request: ExtractedRealEstateRequest, property: Property): MatchingResult {
    if (request.property_type !== 'otro' && request.property_type !== property.property_type) {
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
    // 1. Validar por el Agente 2 (Geolocalización Inexacta / Intenciones) si existe. KAN-22: la
    // zona real (PostGIS + alias, ver zonesService.resolvePropertyZoneId) se resuelve ANTES de
    // llegar acá — esta estrategia es sync/sin red por diseño (matchRequestAgainstProperties se
    // testea sin Supabase), así que solo compara el `neighborhood_id` ya estampado en la
    // property (ver blindMatching.ts#findCrossTenantMatches) contra el del pedido.
    if (zoneIntent && zoneIntent.zona_id !== 'DESCONOCIDO') {
      const propZoneId = property.neighborhood_id ?? null;
      if (propZoneId !== zoneIntent.zona_id) {
        return {
          isMatch: false,
          scoreDeduction: 0,
          reason: propZoneId
            ? `Zona de la propiedad (${propZoneId}) no coincide con la zona del pedido (${zoneIntent.zona_id})`
            : `No se pudo determinar la zona de la propiedad para compararla con la del pedido (${zoneIntent.zona_id})`
        };
      }
      return { isMatch: true, scoreDeduction: 0, reason: `Coincidencia de Zona Geográfica: ${zoneIntent.zona_id}` };
    }

    // 2. Zona de Ubicación General (Si no se usó el Agente 2 para geo-filtrado específico)
    if (request.zones.length > 0) {
      const zoneMatch = request.zones.some(zonaReq =>
        zonaReq.toLowerCase() === (property.zone_display_name ?? '').toLowerCase()
      );
      if (!zoneMatch) {
        return {
          isMatch: false,
          scoreDeduction: 0,
          reason: `Zona de la propiedad (${property.zone_display_name ?? ''}) no solicitada en: ${request.zones.join(', ')}`
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
      : request.bedrooms;

    if (bedroomsRequired !== null) {
      if (property.bedrooms < bedroomsRequired) {
        return {
          isMatch: false,
          scoreDeduction: 0,
          reason: `Faltan dormitorios (pide mínimo ${bedroomsRequired}, tiene ${property.bedrooms})`
        };
      }
      if (property.bedrooms > bedroomsRequired) {
        return {
          isMatch: true,
          scoreDeduction: 10,
          reason: `Tiene más dormitorios de lo requerido (pide ${bedroomsRequired}, tiene ${property.bedrooms})`
        };
      }
    }
    return { isMatch: true, scoreDeduction: 0 };
  }
}

export class BudgetMatchingStrategy implements IMatchingStrategy {
  readonly name = 'Filtro de Presupuesto';

  evaluate(request: ExtractedRealEstateRequest, property: Property): MatchingResult {
    // KAN-72: price <= 0 es dato faltante (celda vacía o precio no parseable en el Excel, ver
    // processExcelBuffer), no un precio real de $0. Tratarlo como "sin datos de precio para
    // comparar" en vez de dejar que la propiedad se salte el filtro de presupuesto sin dejar
    // rastro — no se descarta (no hay base para asumir que excede el presupuesto), pero el
    // motivo queda explícito para quien lea el match.
    if (request.max_budget !== null && property.price <= 0) {
      return {
        isMatch: true,
        scoreDeduction: 0,
        reason: 'No se pudo comparar contra el presupuesto: la propiedad no tiene un precio cargado'
      };
    }

    if (request.max_budget !== null && property.price > 0) {
      let propertyPriceInReqCurrency = property.price;
      let conversionReason = '';

      if (request.currency !== 'desconocido' && request.currency !== property.currency) {
        const dolarRate = getDolarBlueRate();
        if (request.currency === 'USD' && property.currency === 'ARS') {
          propertyPriceInReqCurrency = property.price / dolarRate;
          conversionReason = `Conversión de moneda: propiedad en ARS convertida a USD usando tasa ref $${dolarRate}`;
        } else if (request.currency === 'ARS' && property.currency === 'USD') {
          propertyPriceInReqCurrency = property.price * dolarRate;
          conversionReason = `Conversión de moneda: propiedad en USD convertida a ARS usando tasa ref $${dolarRate}`;
        }
      }

      const toleranceLimit = request.max_budget * 1.05;
      if (propertyPriceInReqCurrency > toleranceLimit) {
        return {
          isMatch: false,
          scoreDeduction: 0,
          reason: `El precio (${property.currency} ${property.price}) excede el presupuesto máximo (${request.currency} ${request.max_budget})`
        };
      }

      if (propertyPriceInReqCurrency > request.max_budget) {
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
      ...request.key_features,
      ...(zoneIntent?.caracteristicas_claves || [])
    ]));

    if (requiredFeatures.length > 0 && property.features) {
      const descLower = (property.features ?? '').toLowerCase();
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
