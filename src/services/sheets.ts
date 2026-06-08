import { google } from 'googleapis';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config/env';

export interface Property {
  domicilio: string;
  pisoLote: string;
  precio: number;
  moneda: 'USD' | 'ARS';
  expensas: number;
  dormitorios: number;
  caracteristicas: string;
  contacto: string;
  zona: string;        // "Yerba Buena" o "San Miguel de Tucumán"
  operacion: 'venta' | 'alquiler'; // Deductible por la pestaña
  tipo_propiedad: 'departamento' | 'casa' | 'terreno' | 'local' | 'oficina' | 'otro';
  sheetName: string;   // Origen de los datos
}

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

/**
 * Obtiene el cliente autenticado de Google Sheets
 */
function getSheetsClient() {
  let auth;

  // 1. Intentar cargar desde la variable de entorno para producción/deploy
  if (process.env.GOOGLE_CREDS_JSON) {
    try {
      const keys = JSON.parse(process.env.GOOGLE_CREDS_JSON);
      auth = new google.auth.GoogleAuth({
        credentials: keys,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } catch (error) {
      console.error('[SHEETS] Error al parsear la variable de entorno GOOGLE_CREDS_JSON:', error);
    }
  }

  // 2. Si no se pudo, caer en el archivo físico local credentials.json
  if (!auth) {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      throw new Error(
        'Falta el archivo credentials.json o la variable de entorno GOOGLE_CREDS_JSON de la Service Account de Google.\n' +
        'Por favor, configúrala para poder acceder a Google Sheets.'
      );
    }

    auth = new google.auth.GoogleAuth({
      keyFile: CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  return google.sheets({ version: 'v4', auth });
}

/**
 * Clasifica el tipo de propiedad basándose en la información disponible en la fila
 */
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

/**
 * Lee todas las pestañas de la cartera de propiedades y las mapea a un array estructurado
 */
export async function getPropertyCatalog(): Promise<Property[]> {
  const sheets = getSheetsClient();
  const spreadsheetId = config.googleSheetId;

  // 1. Obtener información de las pestañas
  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetNames = metadata.data.sheets?.map(s => s.properties?.title || '').filter(Boolean) || [];

  const catalog: Property[] = [];

  for (const name of sheetNames) {
    // Ignorar la pestaña de matches
    if (name === config.googleMatchesTabName) continue;

    // Determinar la operación y zona a partir del nombre de la pestaña (ej: "Ventas Yerba Buena")
    let operacion: 'venta' | 'alquiler' = 'venta';
    if (name.toLowerCase().includes('alquiler') || name.toLowerCase().includes('alq')) {
      operacion = 'alquiler';
    }

    let zona = 'San Miguel de Tucumán';
    if (name.toLowerCase().includes('yerba buena') || name.toLowerCase().includes('yb')) {
      zona = 'Yerba Buena';
    }

    console.log(`Cargando propiedades de la pestaña "${name}" (Zona: ${zona}, Operación: ${operacion})...`);

    // Leer los datos de la pestaña
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${name}!A1:Z500`, // Leer un rango razonable
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) {
      console.log(`La pestaña "${name}" está vacía o no tiene datos suficientes.`);
      continue;
    }

    // Procesar cabeceras para mapeo de columnas dinámicas
    const headers = rows[0].map(h => h.toLowerCase().trim());
    
    // Índices de columnas clave
    const colDomicilio = headers.indexOf('domicilio');
    const colPisoLote = headers.findIndex(h => h.includes('piso') || h.includes('lote'));
    const colPrecio = headers.indexOf('precio');
    const colExpensas = headers.indexOf('expensas');
    const colDormitorios = headers.findIndex(h => h.includes('dormitorio') || h.includes('dorm'));
    const colCaracteristicas = headers.findIndex(h => h.includes('caracteristica') || h.includes('características') || h.includes('descripcion'));
    const colContacto = headers.indexOf('contacto');

    if (colDomicilio === -1 || colPrecio === -1) {
      console.warn(`Pestaña "${name}" omitida: no se encontraron las columnas clave "Domicilio" y "Precio".`);
      continue;
    }

    // Parsear filas de propiedades
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[colDomicilio]) continue; // Fila vacía

      // Parsear precio y moneda (ej: "300 USD" o "$250.000")
      const rawPrecio = row[colPrecio] || '';
      let precioVal = 0;
      let monedaVal: 'USD' | 'ARS' = 'USD'; // Por defecto en Tucumán suele ser USD para ventas

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
      if (colExpensas !== -1 && row[colExpensas]) {
        const cleanedExp = row[colExpensas].replace(/[$,.]/g, '').trim();
        const num = parseFloat(cleanedExp);
        if (!isNaN(num)) expensasVal = num;
      }

      // Parsear dormitorios
      let dormitoriosVal = 0;
      if (colDormitorios !== -1 && row[colDormitorios]) {
        const num = parseInt(row[colDormitorios], 10);
        if (!isNaN(num)) dormitoriosVal = num;
      }

      const rawPisoLote = colPisoLote !== -1 ? row[colPisoLote] || '' : '';
      const rawCaracteristicas = colCaracteristicas !== -1 ? row[colCaracteristicas] || '' : '';

      catalog.push({
        domicilio: row[colDomicilio],
        pisoLote: rawPisoLote,
        precio: precioVal,
        moneda: monedaVal,
        expensas: expensasVal,
        dormitorios: dormitoriosVal,
        caracteristicas: rawCaracteristicas,
        contacto: colContacto !== -1 ? row[colContacto] || '' : '',
        zona,
        operacion,
        tipo_propiedad: detectTipoPropiedad(row[colDomicilio], rawPisoLote, rawCaracteristicas),
        sheetName: name
      });
    }
  }

  console.log(`Total de propiedades cargadas en la cartera: ${catalog.length}`);
  return catalog;
}

/**
 * Guarda un match encontrado en la pestaña [MATCHES ENCONTRADOS]
 */
export async function saveMatch(
  originalText: string,
  contactSender: string,
  property: Property,
  matchDetails: string
): Promise<void> {
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = config.googleSheetId;
    const tabName = config.googleMatchesTabName;

    // Asegurar que la pestaña existe
    try {
      await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tabName}!A1:A2`,
      });
    } catch (error: any) {
      // Si el error indica que la pestaña no existe, la creamos con las cabeceras
      if (error.status === 400 || error.message.includes('not found')) {
        console.log(`Creando pestaña "${tabName}"...`);
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: tabName,
                  },
                },
              },
            ],
          },
        });

        // Escribir cabeceras
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tabName}!A1`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [[
              'Fecha de Match',
              'Origen (Pestaña)',
              'Propiedad Cartera (Domicilio)',
              'Precio Cartera',
              'Contacto Captador',
              'Pedido WhatsApp (Original)',
              'Contacto Solicitante',
              'Detalles de Coincidencia'
            ]],
          },
        });
      } else {
        throw error;
      }
    }

    const fecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' });

    // Agregar fila del match
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A:A`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          fecha,
          property.sheetName,
          `${property.domicilio} ${property.pisoLote}`.trim(),
          `${property.moneda} ${property.precio}`,
          property.contacto,
          originalText,
          contactSender,
          matchDetails
        ]],
      },
    });

    console.log(`¡Match registrado con éxito en Google Sheets para la propiedad: ${property.domicilio}!`);
  } catch (error) {
    console.error('Error al guardar el match en Google Sheets:', error);
  }
}
