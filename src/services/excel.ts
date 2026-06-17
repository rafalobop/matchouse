import * as xlsx from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { Property, detectTipoPropiedad } from './sheets';

function getCatalogPath(tenantId: string): string {
  return path.join(process.cwd(), `catalog_${tenantId}.json`);
}

/**
 * Guarda el catálogo de propiedades en un archivo JSON local por tenant
 */
export function saveCatalogToDisk(catalog: Property[], tenantId: string): void {
  try {
    const catalogPath = getCatalogPath(tenantId);
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');
    console.log(`[EXCEL] Catálogo guardado en disco para tenant ${tenantId} (${catalog.length} propiedades).`);
  } catch (error) {
    console.error(`[EXCEL] Error al guardar catálogo en disco para tenant ${tenantId}:`, error);
  }
}

/**
 * Carga el catálogo de propiedades desde el archivo JSON local del tenant si existe
 */
export function loadCatalogFromDisk(tenantId: string): Property[] {
  try {
    const catalogPath = getCatalogPath(tenantId);
    if (fs.existsSync(catalogPath)) {
      const data = fs.readFileSync(catalogPath, 'utf-8');
      const catalog = JSON.parse(data) as Property[];
      console.log(`[EXCEL] Catálogo cargado desde disco para tenant ${tenantId} (${catalog.length} propiedades).`);
      return catalog;
    }
  } catch (error) {
    console.error(`[EXCEL] Error al cargar catálogo desde disco para tenant ${tenantId}:`, error);
  }
  return [];
}

/**
 * Procesa un buffer de archivo Excel y lo convierte a un arreglo de Property
 */
export function processExcelBuffer(buffer: Buffer): Property[] {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const catalog: Property[] = [];

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
        if (!isNaN(num)) {
          precioVal = num;
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
        domicilio: rowDomicilioText,
        pisoLote: rawPisoLote,
        precio: precioVal,
        moneda: monedaVal,
        expensas: expensasVal,
        dormitorios: dormitoriosVal,
        caracteristicas: rawCaracteristicas,
        contacto: colContacto !== -1 ? String(row[colContacto] || '') : '',
        zona,
        operacion: operacionProp,
        tipo_propiedad: tipoPropiedad,
        latitud: latitudVal,
        longitud: longitudVal,
        sheetName
      });
    }
  }

  return catalog;
}
