// KAN-125: `xlsx` migrado desde el registro público de npm (parado en 0.18.5, con vulnerabilidades
// conocidas — prototype pollution / ReDoS — que SheetJS nunca volvió a parchear ahí) al tarball
// oficial parcheado servido desde su propio CDN (ver dependencia en package.json:
// "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"). Superficie de API real usada en
// todo el proyecto (documentada acá porque no hay otro lugar natural donde quede a la vista antes
// de tocar la dependencia):
//   - Lectura (este archivo, producción): `xlsx.read()` y `xlsx.utils.sheet_to_json()` únicamente.
//     Nunca se genera un .xlsx desde el servidor (no hay `xlsx.write()` en código de producción).
//   - Construcción de fixtures de test (`tests/excel.test.ts`): `xlsx.utils.book_new()`,
//     `xlsx.utils.book_append_sheet()`, `xlsx.utils.aoa_to_sheet()` y `xlsx.write()`.
// Misma API en 0.20.3 que en 0.18.5 para esta superficie acotada — sin cambios de código
// necesarios en `excel.ts` ni en los tests. Confirmado con la suite completa en verde y un
// smoke test manual end-to-end (buffer .xlsx real generado y parseado con la versión nueva).
import * as xlsx from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger';
import { supabase as serviceRoleSupabase } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { geocodeAddress, GeocodeResult } from './geocoding';
import { buildGeocodableQuery } from '../utils/addressParser';
import { ExcelMappingField, EXCEL_MAPPING_FIELDS, computeHeaderSignature } from '../utils/excelHeaderMatcher';
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

// KAN-84: índices de columna resueltos para una hoja, uno por cada campo de negocio conocido
// (-1 = columna no encontrada). Producido tanto por la heurística por defecto
// (`resolveHeuristicColumnIndices`, sin cambios de comportamiento respecto al código pre-KAN-84)
// como por el mapeo aprendido/confirmado por tenant (`processExcelBufferWithColumnMap`) — ambos
// alimentan el mismo `parseSheetToProperties`, sin duplicar la lógica de parseo de filas.
type SheetColumnIndices = Record<ExcelMappingField, number>;

// Heurística por defecto: exactamente la misma resolución de columnas que vivía inline en
// `processExcelBuffer` antes de KAN-84 (mismos keywords, mismo fallback de "domicilio" a la
// columna 0). Preservada tal cual para no alterar el comportamiento ya cubierto por
// `tests/excel.test.ts`.
function resolveHeuristicColumnIndices(headers: string[], sheetName: string): SheetColumnIndices {
  let domicilio = headers.indexOf('domicilio');
  if (domicilio === -1) {
    // Si no hay columna "domicilio", asumir la primera columna (columna 0) como la dirección
    domicilio = 0;
    logger.info({ sheetName, assumedHeader: headers[0] }, '[EXCEL] No se encontró columna "domicilio". Asumiendo columna 0 como domicilio.');
  }

  return {
    domicilio,
    piso_lote: headers.findIndex(h => h.includes('piso') || h.includes('lote')),
    precio: headers.indexOf('precio'),
    expensas: headers.indexOf('expensas'),
    dormitorios: headers.findIndex(h => h.includes('dormitorio') || h.includes('dorm')),
    caracteristicas: headers.findIndex(h => h.includes('caracteristica') || h.includes('características') || h.includes('descripcion')),
    contacto: headers.indexOf('contacto'),
    tipo: headers.indexOf('tipo'),
    operacion: headers.indexOf('operacion'),
    latitud: headers.indexOf('latitud'),
    longitud: headers.indexOf('longitud')
  };
}

// KAN-84: resuelve los índices de columna a partir de un mapeo de campo -> texto de header
// (aprendido/confirmado por tenant, ver excelMapping.ts), buscando ese texto exacto (sin
// distinguir mayúsculas) dentro de los headers reales de ESTA hoja. Si el header guardado ya no
// aparece (la agencia cambió el Excel), el campo queda sin resolver (-1) — mismo criterio de
// "hoja sin domicilio/precio se omite" que ya aplica en el camino heurístico.
function resolveColumnIndicesFromMapping(headers: string[], mapping: Partial<Record<ExcelMappingField, string | null>>): SheetColumnIndices {
  const indices = {} as SheetColumnIndices;
  for (const field of EXCEL_MAPPING_FIELDS) {
    const headerText = mapping[field];
    indices[field] = headerText ? headers.indexOf(headerText.toLowerCase().trim()) : -1;
  }
  return indices;
}

// Parseo de filas, compartido por `processExcelBuffer` (columnas resueltas por heurística) y
// `processExcelBufferWithColumnMap` (columnas resueltas por el mapeo aprendido por tenant) — sin
// cambios de comportamiento respecto al bucle que vivía inline en `processExcelBuffer` antes de
// KAN-84, solo parametrizado por `colIndices` en vez de variables `colX` individuales.
function parseSheetToProperties(
  rows: any[][],
  colIndices: SheetColumnIndices,
  sheetName: string,
  operacionDefault: 'venta' | 'alquiler',
  zona: string
): { properties: Property[]; priceParseErrors: PriceParseError[] } {
  const properties: Property[] = [];
  const priceParseErrors: PriceParseError[] = [];
  const { domicilio: colDomicilio, piso_lote: colPisoLote, precio: colPrecio, expensas: colExpensas,
    dormitorios: colDormitorios, caracteristicas: colCaracteristicas, contacto: colContacto,
    tipo: colTipo, operacion: colOperacion, latitud: colLatitud, longitud: colLongitud } = colIndices;

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
    let operacionProp = operacionDefault;
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

    properties.push({
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

  return { properties, priceParseErrors };
}

function sheetOperacionYZona(sheetName: string): { operacion: 'venta' | 'alquiler'; zona: string } {
  let operacion: 'venta' | 'alquiler' = 'venta';
  if (sheetName.toLowerCase().includes('alquiler') || sheetName.toLowerCase().includes('alq')) {
    operacion = 'alquiler';
  }

  let zona = 'San Miguel de Tucumán';
  if (sheetName.toLowerCase().includes('yerba buena') || sheetName.toLowerCase().includes('yb')) {
    zona = 'Yerba Buena';
  }

  return { operacion, zona };
}

export interface SheetHeaders {
  sheetName: string;
  headers: string[];
}

// KAN-84: extrae solo los headers (fila 0) de cada hoja no vacía, sin parsear filas — usado por
// `POST /api/upload` (src/index.ts) para resolver el mapeo de columnas por tenant ANTES de
// decidir con qué función procesar el archivo completo (`processExcelBuffer` o
// `processExcelBufferWithColumnMap`). Mismo criterio de "hoja vacía" que ambas (rows.length < 2).
export function peekExcelHeaders(buffer: Buffer): SheetHeaders[] {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const result: SheetHeaders[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json<any[]>(worksheet, { header: 1 });
    if (!rows || rows.length < 2) continue;

    const headers = (rows[0] as any[]).map(h => String(h || '').toLowerCase().trim());
    result.push({ sheetName, headers });
  }

  return result;
}

/**
 * Procesa un buffer de archivo Excel y lo convierte a un arreglo de Property, resolviendo las
 * columnas por la heurística de keywords por defecto (sin aprendizaje por tenant — ver
 * `processExcelBufferWithColumnMap` para el camino que usa un mapeo aprendido/confirmado, KAN-84).
 */
export function processExcelBuffer(buffer: Buffer): ProcessExcelResult {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const catalog: Property[] = [];
  const priceParseErrors: PriceParseError[] = [];

  for (const sheetName of workbook.SheetNames) {
    const { operacion, zona } = sheetOperacionYZona(sheetName);

    const worksheet = workbook.Sheets[sheetName];
    // Convertir a matriz de filas
    const rows = xlsx.utils.sheet_to_json<any[]>(worksheet, { header: 1 });

    if (!rows || rows.length < 2) {
      logger.info({ sheetName }, '[EXCEL] La pestaña está vacía o no tiene suficientes filas.');
      continue;
    }

    // Procesar cabeceras
    const headers = (rows[0] as any[]).map(h => String(h || '').toLowerCase().trim());
    const colIndices = resolveHeuristicColumnIndices(headers, sheetName);

    if (colIndices.domicilio === -1 || colIndices.precio === -1) {
      logger.warn({ sheetName }, '[EXCEL] Pestaña omitida: no se encontró la columna de Precio o el Domicilio.');
      continue;
    }

    logger.info({ sheetName, zona, operacion }, '[EXCEL] Procesando pestaña...');

    const sheetResult = parseSheetToProperties(rows, colIndices, sheetName, operacion, zona);
    catalog.push(...sheetResult.properties);
    priceParseErrors.push(...sheetResult.priceParseErrors);
  }

  return { properties: catalog, priceParseErrors };
}

// KAN-84: variante que resuelve las columnas de cada hoja a partir de un mapeo por tenant ya
// aprendido/confirmado (ver `excelMapping.ts#resolveColumnMapping`), en vez de la heurística fija
// de keywords en español. `mappingsBySignature` está keyeado por `computeHeaderSignature` de la
// hoja (headers normalizados y ordenados) — permite que un mismo archivo con varias pestañas de
// estructura distinta use el mapeo correcto para cada una. Una hoja cuya firma no está en el mapa
// (o cuyo mapeo resuelto deja domicilio/precio sin encontrar) se omite, igual que el camino
// heurístico.
export function processExcelBufferWithColumnMap(
  buffer: Buffer,
  mappingsBySignature: Map<string, Partial<Record<ExcelMappingField, string | null>>>
): ProcessExcelResult {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const catalog: Property[] = [];
  const priceParseErrors: PriceParseError[] = [];

  for (const sheetName of workbook.SheetNames) {
    const { operacion, zona } = sheetOperacionYZona(sheetName);

    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json<any[]>(worksheet, { header: 1 });

    if (!rows || rows.length < 2) {
      logger.info({ sheetName }, '[EXCEL] La pestaña está vacía o no tiene suficientes filas.');
      continue;
    }

    const headersRaw = (rows[0] as any[]).map(h => String(h || '').toLowerCase().trim());
    const signature = computeHeaderSignature(headersRaw);
    const mapping = mappingsBySignature.get(signature);

    if (!mapping) {
      logger.warn({ sheetName, signature }, '[EXCEL] No hay mapeo de columnas resuelto para esta hoja, se omite.');
      continue;
    }

    const colIndices = resolveColumnIndicesFromMapping(headersRaw, mapping);
    if (colIndices.domicilio === -1 || colIndices.precio === -1) {
      logger.warn({ sheetName }, '[EXCEL] El mapeo de columnas no resuelve domicilio/precio en esta hoja, se omite.');
      continue;
    }

    const sheetResult = parseSheetToProperties(rows, colIndices, sheetName, operacion, zona);
    catalog.push(...sheetResult.properties);
    priceParseErrors.push(...sheetResult.priceParseErrors);
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
