import * as xlsx from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger';
import { supabase as serviceRoleSupabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { geocodeAddress, GeocodeResult } from './geocoding';
import { buildGeocodableQuery } from '../utils/addressParser';
export interface Property {
  // Address components (era: domicilio + pisoLote)
  address: string;
  floor?: string;
  unit?: string;
  block?: string;
  lot?: string;

  // Pricing
  price: number;
  currency: 'USD' | 'ARS';
  maintenance_fees?: number;   // era: expensas

  // Details
  bedrooms: number;
  features?: string;           // era: caracteristicas
  contact_info?: string;       // era: contacto
  property_type: 'departamento' | 'casa' | 'terreno' | 'local' | 'oficina' | 'otro';
  operation: 'venta' | 'alquiler';

  // Zone (solo runtime — NO se persiste en BD)
  zone_display_name?: string;  // era: zona
  // KAN-22: id de neighborhoods.id resuelto vía PostGIS/alias (zonesService.resolvePropertyZoneId),
  // estampado por findCrossTenantMatches SOLO cuando la búsqueda trae un zoneIntent concreto —
  // no se resuelve en el resto de los flujos (upload, arranque). Solo runtime, no se persiste en BD.
  neighborhood_id?: string | null;

  // Metadata
  sheet_name: string;          // era: sheetName
  // KAN-80: nullable — `undefined` en un Property recién parseado del Excel significa "sin
  // columna de coordenadas en la hoja" (se resuelve vía geocoding en syncPropertiesToDatabase);
  // `null` en un Property rehidratado desde la base significa "se intentó geocodificar y falló"
  // (ver GeocodingService). Nunca se cae a 0/0 como fallback silencioso (bug corregido en KAN-80).
  latitude?: number | null;    // era: latitud
  longitude?: number | null;   // era: longitud
}

// KAN-72: fila donde la celda de precio tenía contenido pero no se pudo interpretar como un
// número válido (o resolvió a un valor <= 0, ej. "consultar" o un typo). La propiedad igual se
// agrega al catálogo con price=0 (ver BudgetMatchingStrategy, que ahora trata price<=0 como dato
// faltante en vez de dejarla saltarse el filtro de presupuesto sin más), pero el usuario necesita
// verlo para poder corregir el Excel.
export interface PriceParseError {
  sheetName: string;
  address: string;
  rawValue: string;
}

export interface ProcessExcelResult {
  properties: Property[];
  priceParseErrors: PriceParseError[];
}

export function detectTipoPropiedad(
  domicilio: string,
  pisoLote: string,
  caracteristicas: string
): 'departamento' | 'casa' | 'terreno' | 'local' | 'oficina' | 'otro' {
  const text = `${domicilio} ${pisoLote} ${caracteristicas}`.toLowerCase();

  if (text.includes('lote') || text.includes('terreno') || text.includes('tierra')) {
    return 'terreno';
  }
  if (text.includes('oficina') || text.includes('consultorio')) {
    return 'oficina';
  }
  if (text.includes('local') || text.includes('negocio') || text.includes('salon comercial')) {
    return 'local';
  }
  if (
    text.includes('dpto') ||
    text.includes('depto') ||
    text.includes('departamento') ||
    text.includes('piso') ||
    text.includes('semipiso') ||
    text.includes('monoambiente')
  ) {
    return 'departamento';
  }
  if (text.includes('casa') || text.includes('duplex') || text.includes('chalet') || text.includes('propiedad')) {
    return 'casa';
  }

  // Heurística de respaldo basada en el número de departamento/piso
  if (pisoLote && (pisoLote.toLowerCase().includes('piso') || pisoLote.toLowerCase().includes('dpto') || /[a-z]/i.test(pisoLote))) {
    return 'departamento';
  }

  return 'casa'; // Valor por defecto
}

function parsePisoLote(raw: string): { floor?: string; unit?: string; block?: string; lot?: string } {
  if (!raw.trim()) return {};
  const lower = raw.toLowerCase().trim();
  if (lower.includes('lote') || lower.includes('terreno')) return { lot: raw.trim() };
  const blockMatch = lower.match(/bloqu?e?\s*([a-z0-9]+)/i);
  if (blockMatch) return { block: blockMatch[1].toUpperCase() };
  const floorUnitMatch = lower.match(/piso\s*(\d+)\s*(?:dpto?\.?\s*)?([a-z0-9]+)/i);
  if (floorUnitMatch) return { floor: floorUnitMatch[1], unit: floorUnitMatch[2].toUpperCase() };
  return { unit: raw.trim() };
}

/**
 * Procesa un buffer de archivo Excel y lo convierte a un arreglo de Property
 */
export function processExcelBuffer(buffer: Buffer): ProcessExcelResult {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const catalog: Property[] = [];
  const priceParseErrors: PriceParseError[] = [];

  for (const sheetName of workbook.SheetNames) {
    // Determinar operación y zona según el nombre de la pestaña
    let operacion: 'venta' | 'alquiler' = 'venta';
    if (sheetName.toLowerCase().includes('alquiler') || sheetName.toLowerCase().includes('alq')) {
      operacion = 'alquiler';
    }

    let zona = 'San Miguel de Tucumán';
    if (sheetName.toLowerCase().includes('yerba buena') || sheetName.toLowerCase().includes('yb')) {
      zona = 'Yerba Buena';
    }

    const worksheet = workbook.Sheets[sheetName];
    // Convertir a matriz de filas
    const rows = xlsx.utils.sheet_to_json<any[]>(worksheet, { header: 1 });

    if (!rows || rows.length < 2) {
      console.log(`[EXCEL] La pestaña "${sheetName}" está vacía o no tiene suficientes filas.`);
      continue;
    }

    // Procesar cabeceras
    const headers = (rows[0] as any[]).map(h => String(h || '').toLowerCase().trim());

    // Índices de columnas clave (con soporte flexible)
    let colDomicilio = headers.indexOf('domicilio');
    if (colDomicilio === -1) {
      // Si no hay columna "domicilio", asumir la primera columna (columna 0) como la dirección
      colDomicilio = 0;
      console.log(`[EXCEL] No se encontró columna "domicilio". Asumiendo columna 0 ("${headers[0]}") como domicilio.`);
    }
    const colPisoLote = headers.findIndex(h => h.includes('piso') || h.includes('lote'));
    const colPrecio = headers.indexOf('precio');
    const colExpensas = headers.indexOf('expensas');
    const colDormitorios = headers.findIndex(h => h.includes('dormitorio') || h.includes('dorm'));
    const colCaracteristicas = headers.findIndex(h => h.includes('caracteristica') || h.includes('características') || h.includes('descripcion'));
    const colContacto = headers.indexOf('contacto');

    // Columnas de tipo y operacion explicitas (Opción A)
    const colTipo = headers.indexOf('tipo');
    const colOperacion = headers.indexOf('operacion');
    
    // Coordenadas
    const colLatitud = headers.indexOf('latitud');
    const colLongitud = headers.indexOf('longitud');

    if (colDomicilio === -1 || colPrecio === -1) {
      console.warn(`[EXCEL] Pestaña "${sheetName}" omitida: no se encontró la columna de Precio o el Domicilio.`);
      continue;
    }

    console.log(`[EXCEL] Procesando pestaña "${sheetName}" (Zona predeterminada: ${zona}, Operación predeterminada: ${operacion})...`);

    // Parsear filas
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as any[];
      if (!row || !row[colDomicilio]) continue; // Fila vacía

      // Evitar procesar filas separadoras/agrupadoras vacías
      const rowDomicilioText = String(row[colDomicilio] || '').trim();
      const nonEpCount = row.filter(cell => cell !== null && cell !== undefined && String(cell).trim() !== '').length;
      if (nonEpCount <= 2 && (rowDomicilioText.toUpperCase() === rowDomicilioText) && rowDomicilioText.length > 3) {
        // Ignorar fila de separador/título visual (ej: "VENTAS CASAS CAPITAL")
        continue;
      }

      // Parsear precio y moneda
      const rawPrecio = String(row[colPrecio] || '').trim();
      let precioVal = 0;
      let monedaVal: 'USD' | 'ARS' = 'USD';

      if (rawPrecio) {
        // 1. Detectar moneda
        const rawLower = rawPrecio.toLowerCase();
        if (rawLower.includes('ars') || rawLower.includes('$') || rawLower.includes('pesos')) {
          monedaVal = 'ARS';
        } else {
          monedaVal = 'USD'; // Por defecto
        }

        // 2. Limpiar el precio removiendo letras, signo $, y espacios
        let cleaned = rawPrecio.replace(/[a-zA-Z\$\s]/g, '').trim();

        // 3. Normalizar separadores de miles y decimales
        if (cleaned.includes(',') && cleaned.includes('.')) {
          // Si tiene ambos, ej "120.000,50" -> remover puntos y cambiar coma a punto
          cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
        } else if (cleaned.includes(',')) {
          // Si solo tiene coma: "120000,50" -> decimal, "120,000" -> miles
          const parts = cleaned.split(',');
          if (parts.length === 2 && parts[1].length <= 2) {
            cleaned = cleaned.replace(/,/g, '.');
          } else {
            cleaned = cleaned.replace(/,/g, '');
          }
        } else if (cleaned.includes('.')) {
          // Si solo tiene punto: "120.000" -> miles (quitar), "120000.50" -> decimal (mantener)
          const parts = cleaned.split('.');
          if (parts.length === 2 && parts[1].length <= 2) {
            // Es decimal, mantener punto
          } else {
            cleaned = cleaned.replace(/\./g, '');
          }
        }

        const num = parseFloat(cleaned);
        if (!isNaN(num) && num > 0) {
          precioVal = num;
        } else {
          logger.warn(
            { sheetName, address: rowDomicilioText, rawValue: rawPrecio },
            '[EXCEL] Precio no parseable en fila, se registra como dato faltante (price=0)'
          );
          priceParseErrors.push({ sheetName, address: rowDomicilioText, rawValue: rawPrecio });
        }
      }

      // Parsear expensas
      let expensasVal = 0;
      if (colExpensas !== -1 && row[colExpensas] !== undefined) {
        const rawExp = String(row[colExpensas]).trim();
        let cleanedExp = rawExp.replace(/[a-zA-Z\$\s]/g, '').trim();
        if (cleanedExp.includes(',') && cleanedExp.includes('.')) {
          cleanedExp = cleanedExp.replace(/\./g, '').replace(/,/g, '.');
        } else if (cleanedExp.includes(',')) {
          const parts = cleanedExp.split(',');
          if (parts.length === 2 && parts[1].length <= 2) {
            cleanedExp = cleanedExp.replace(/,/g, '.');
          } else {
            cleanedExp = cleanedExp.replace(/,/g, '');
          }
        } else if (cleanedExp.includes('.')) {
          const parts = cleanedExp.split('.');
          if (parts.length === 2 && parts[1].length <= 2) {
            // decimal, mantener
          } else {
            cleanedExp = cleanedExp.replace(/\./g, '');
          }
        }
        const num = parseFloat(cleanedExp);
        if (!isNaN(num)) expensasVal = num;
      }

      // Parsear dormitorios
      let dormitoriosVal = 0;
      if (colDormitorios !== -1 && row[colDormitorios] !== undefined) {
        const num = parseInt(String(row[colDormitorios]), 10);
        if (!isNaN(num)) dormitoriosVal = num;
      }

      const rawPisoLote = colPisoLote !== -1 ? String(row[colPisoLote] || '') : '';
      const rawCaracteristicas = colCaracteristicas !== -1 ? String(row[colCaracteristicas] || '') : '';

      // Determinar tipo de propiedad (columna explícita o heurística)
      let tipoPropiedad = detectTipoPropiedad(rowDomicilioText, rawPisoLote, rawCaracteristicas);
      if (colTipo !== -1 && row[colTipo]) {
        const rawTipo = String(row[colTipo]).toLowerCase().trim();
        if (rawTipo.includes('casa')) {
          tipoPropiedad = 'casa';
        } else if (rawTipo.includes('dpto') || rawTipo.includes('depto') || rawTipo.includes('departamento')) {
          tipoPropiedad = 'departamento';
        } else if (rawTipo.includes('terreno') || rawTipo.includes('lote')) {
          tipoPropiedad = 'terreno';
        } else if (rawTipo.includes('local')) {
          tipoPropiedad = 'local';
        } else if (rawTipo.includes('oficina')) {
          tipoPropiedad = 'oficina';
        } else if (rawTipo.includes('otro')) {
          tipoPropiedad = 'otro';
        }
      }

      // Determinar operación (columna explícita o predeterminada por hoja)
      let operacionProp = operacion;
      if (colOperacion !== -1 && row[colOperacion]) {
        const rawOperacion = String(row[colOperacion]).toLowerCase().trim();
        if (rawOperacion.includes('alquiler') || rawOperacion.includes('alq')) {
          operacionProp = 'alquiler';
        } else if (rawOperacion.includes('venta') || rawOperacion.includes('vta')) {
          operacionProp = 'venta';
        }
      }

      // Parsear latitud y longitud
      let latitudVal: number | undefined = undefined;
      let longitudVal: number | undefined = undefined;
      if (colLatitud !== -1 && row[colLatitud] !== undefined) {
        const val = parseFloat(String(row[colLatitud]));
        if (!isNaN(val)) latitudVal = val;
      }
      if (colLongitud !== -1 && row[colLongitud] !== undefined) {
        const val = parseFloat(String(row[colLongitud]));
        if (!isNaN(val)) longitudVal = val;
      }

      catalog.push({
        address: rowDomicilioText,
        ...parsePisoLote(rawPisoLote),
        price: precioVal,
        currency: monedaVal,
        maintenance_fees: expensasVal,
        bedrooms: dormitoriosVal,
        features: rawCaracteristicas,
        contact_info: colContacto !== -1 ? String(row[colContacto] || '') : '',
        zone_display_name: zona,
        operation: operacionProp,
        property_type: tipoPropiedad,
        latitude: latitudVal,
        longitude: longitudVal,
        sheet_name: sheetName
      });
    }
  }

  return { properties: catalog, priceParseErrors };
}

// KAN-63 (patrón "Tenant Context"): acepta un cliente Supabase opcional, scoped al tenant
// (anon key + JWT del usuario vía getTenantClient), para que RLS se aplique de verdad en la
// única ruta HTTP autenticada que escribe en `properties` (/api/upload). Si no se pasa
// ninguno, usa el cliente service-role (comportamiento previo, para no romper otros
// llamadores hipotéticos fuera de un request HTTP).
export async function syncPropertiesToDatabase(
  properties: Property[],
  tenantId: string,
  client: SupabaseClient = serviceRoleSupabase,
  // KAN-80: inyectable (mismo patrón que `client`) para poder testear sin pegarle a Nominatim
  // real ni quedar atado a su límite de 1 request/seg durante la suite.
  geocodeFn: (query: string) => Promise<GeocodeResult> = geocodeAddress
): Promise<void> {
  try {
    logger.info({ propertiesCount: properties.length, tenantId }, '[SUPABASE] Iniciando sincronización de propiedades...');

    // 1. Obtener todas las propiedades actuales de Supabase filtradas por tenant_id (incluye
    // lat/lng ya resueltas para no re-geocodificar en cada subida una propiedad sin cambios).
    const { data: dbProps, error: fetchErr } = await client
      .from('properties')
      .select('id, address, floor, unit, block, lot, price, contact_info, sheet_name, latitude, longitude')
      .eq('tenant_id', tenantId);

    if (fetchErr) {
      throw fetchErr;
    }

    const dbProperties = dbProps || [];

    // 2. Mapear en memoria los registros actuales
    const dbPropsMap = new Map<string, string>(); // clave -> id
    const dbCoordsMap = new Map<string, { latitude: number | null; longitude: number | null }>(); // id -> coords ya resueltas
    dbProperties.forEach((p: any) => {
      const key = `${p.address}_${p.floor || ''}_${p.unit || ''}_${p.block || ''}_${p.lot || ''}_${p.price}_${p.contact_info || ''}_${p.sheet_name}`.toLowerCase().trim();
      dbPropsMap.set(key, p.id);
      dbCoordsMap.set(p.id, { latitude: p.latitude ?? null, longitude: p.longitude ?? null });
    });

    // 3. Iterar las propiedades frescas, clasificarlas y resolver lat/lng
    const upsertList: any[] = [];
    const matchedIds = new Set<string>();

    for (const p of properties) {
      const key = `${p.address}_${p.floor || ''}_${p.unit || ''}_${p.block || ''}_${p.lot || ''}_${p.price}_${p.contact_info || ''}_${p.sheet_name}`.toLowerCase().trim();
      const existingId = dbPropsMap.get(key);

      let latitude: number | null = p.latitude ?? null;
      let longitude: number | null = p.longitude ?? null;

      if (latitude === null || longitude === null) {
        const existingCoords = existingId ? dbCoordsMap.get(existingId) : undefined;
        if (existingCoords && existingCoords.latitude !== null && existingCoords.longitude !== null) {
          // Propiedad sin cambios y ya geocodificada en una sincronización previa: se reutiliza
          // en vez de volver a consultar el servicio de geocoding (evita gasto/latencia inútil).
          latitude = existingCoords.latitude;
          longitude = existingCoords.longitude;
        } else {
          const { normalized } = buildGeocodableQuery({ address: p.address, zone_display_name: p.zone_display_name });
          const geocodeResult = await geocodeFn(normalized);
          if (geocodeResult.success) {
            latitude = geocodeResult.latitude;
            longitude = geocodeResult.longitude;
            logger.info({ tenantId, address: p.address, latitude, longitude }, '[EXCEL] Propiedad geocodificada correctamente al sincronizar');
          } else {
            latitude = null;
            longitude = null;
            logger.warn({ tenantId, address: p.address, reason: geocodeResult.reason }, '[EXCEL] No se pudo geocodificar la propiedad, se guarda sin coordenadas');
          }
        }
      }

      const propertyPayload = {
        id: existingId || randomUUID(),
        address: p.address,
        floor: p.floor || null,
        unit: p.unit || null,
        block: p.block || null,
        lot: p.lot || null,
        price: p.price,
        currency: p.currency,
        maintenance_fees: p.maintenance_fees ?? 0,
        bedrooms: p.bedrooms,
        features: p.features || null,
        contact_info: p.contact_info || null,
        operation: p.operation,
        property_type: p.property_type,
        sheet_name: p.sheet_name,
        latitude,
        longitude,
        tenant_id: tenantId
      };

      if (existingId) {
        matchedIds.add(existingId);
      }
      upsertList.push(propertyPayload);
    }

    // 4. Generar lista de eliminaciones
    const deleteList: string[] = [];
    dbProperties.forEach((p: any) => {
      if (!matchedIds.has(p.id)) {
        deleteList.push(p.id);
      }
    });

    // 5. Ejecutar operaciones
    if (upsertList.length > 0) {
      const { error: upsertErr } = await client
        .from('properties')
        .upsert(upsertList);

      if (upsertErr) {
        throw upsertErr;
      }
    }

    if (deleteList.length > 0) {
      const { error: deleteErr } = await client
        .from('properties')
        .delete()
        .in('id', deleteList)
        .eq('tenant_id', tenantId);

      if (deleteErr) {
        throw deleteErr;
      }
    }
    
    logger.info({ 
      upsertedCount: upsertList.length, 
      deletedCount: deleteList.length,
      tenantId
    }, '[SUPABASE] Sincronización de propiedades finalizada con éxito.');
  } catch (error: any) {
    logger.error({ error: error.message || error, tenantId }, '[SUPABASE] Error al sincronizar propiedades');
    throw error;
  }
}
