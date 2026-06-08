import * as xlsx from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { Property, detectTipoPropiedad } from './sheets';

const CATALOG_PATH = path.join(process.cwd(), 'catalog.json');

/**
 * Guarda el catálogo de propiedades en un archivo JSON local
 */
export function saveCatalogToDisk(catalog: Property[]): void {
  try {
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), 'utf-8');
    console.log(`[EXCEL] Catálogo guardado en disco (${catalog.length} propiedades).`);
  } catch (error) {
    console.error('[EXCEL] Error al guardar catálogo en disco:', error);
  }
}

/**
 * Carga el catálogo de propiedades desde el archivo JSON local si existe
 */
export function loadCatalogFromDisk(): Property[] {
  try {
    if (fs.existsSync(CATALOG_PATH)) {
      const data = fs.readFileSync(CATALOG_PATH, 'utf-8');
      const catalog = JSON.parse(data) as Property[];
      console.log(`[EXCEL] Catálogo cargado desde disco (${catalog.length} propiedades).`);
      return catalog;
    }
  } catch (error) {
    console.error('[EXCEL] Error al cargar catálogo desde disco:', error);
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

    // Índices de columnas clave (Igual que en sheets.ts)
    const colDomicilio = headers.indexOf('domicilio');
    const colPisoLote = headers.findIndex(h => h.includes('piso') || h.includes('lote'));
    const colPrecio = headers.indexOf('precio');
    const colExpensas = headers.indexOf('expensas');
    const colDormitorios = headers.findIndex(h => h.includes('dormitorio') || h.includes('dorm'));
    const colCaracteristicas = headers.findIndex(h => h.includes('caracteristica') || h.includes('características') || h.includes('descripcion'));
    const colContacto = headers.indexOf('contacto');

    if (colDomicilio === -1 || colPrecio === -1) {
      console.warn(`[EXCEL] Pestaña "${sheetName}" omitida: no se encontraron las columnas clave "Domicilio" y "Precio".`);
      continue;
    }

    console.log(`[EXCEL] Procesando pestaña "${sheetName}" (Zona: ${zona}, Operación: ${operacion})...`);

    // Parsear filas
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as any[];
      if (!row || !row[colDomicilio]) continue; // Fila vacía

      // Parsear precio y moneda
      const rawPrecio = String(row[colPrecio] || '');
      let precioVal = 0;
      let monedaVal: 'USD' | 'ARS' = 'USD';

      if (rawPrecio) {
        const cleanedPrecio = rawPrecio.replace(/[$,.]/g, '').trim();
        const num = parseFloat(cleanedPrecio);
        if (!isNaN(num)) {
          precioVal = num;
        }
        if (rawPrecio.toLowerCase().includes('ars') || rawPrecio.includes('$') || rawPrecio.toLowerCase().includes('pesos')) {
          monedaVal = 'ARS';
        }
      }

      // Parsear expensas
      let expensasVal = 0;
      if (colExpensas !== -1 && row[colExpensas] !== undefined) {
        const cleanedExp = String(row[colExpensas]).replace(/[$,.]/g, '').trim();
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

      catalog.push({
        domicilio: String(row[colDomicilio]),
        pisoLote: rawPisoLote,
        precio: precioVal,
        moneda: monedaVal,
        expensas: expensasVal,
        dormitorios: dormitoriosVal,
        caracteristicas: rawCaracteristicas,
        contacto: colContacto !== -1 ? String(row[colContacto] || '') : '',
        zona,
        operacion,
        tipo_propiedad: detectTipoPropiedad(String(row[colDomicilio]), rawPisoLote, rawCaracteristicas),
        sheetName
      });
    }
  }

  return catalog;
}
