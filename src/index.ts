import express from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { startWhatsAppClient, loadSettings, saveSettings, getActiveGroups, whatsappStatus, restartWhatsAppClient, sendWhatsAppNotification } from './services/whatsapp';
import { extractRealEstateRequest, extractZoneIntent, ZoneIntentRequest } from './services/gemini';
import { saveMatch, Property } from './services/sheets';
import { isRealEstateRequest } from './utils/filter';
import { checkMatch } from './utils/matcher';
import { loadCatalogFromDisk, saveCatalogToDisk, processExcelBuffer } from './services/excel';

// In-memory property catalog and matches log
let propertyCatalog: Property[] = [];
const recentMatches: any[] = [];

// Express Setup
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

// Capturar errores no controlados para evitar que el servidor se caiga por fallas internas de librerías (ej. borrado de sesiones de whatsapp-web.js en Windows)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[PROCESO] Promesa no capturada (Unhandled Rejection):', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[PROCESO] Error no controlado (Uncaught Exception):', error);
});

app.use(express.json());

// Servir archivos estáticos del dashboard (soportando dev y prod)
const dashboardPath = fs.existsSync(path.join(__dirname, 'dashboard'))
  ? path.join(__dirname, 'dashboard')
  : path.join(process.cwd(), 'src', 'dashboard');
app.use(express.static(dashboardPath));

// Endpoints de la API
app.get('/api/status', (req, res) => {
  res.json(whatsappStatus);
});

app.post('/api/whatsapp/restart', async (req, res) => {
  try {
    await restartWhatsAppClient();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al reiniciar cliente.' });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await getActiveGroups();
    const settings = loadSettings();
    res.json({
      groups,
      selected: settings.selectedGroups
    });
  } catch (error) {
    res.status(500).json({ error: 'No se pudieron recuperar los grupos.' });
  }
});

app.post('/api/groups', (req, res) => {
  const { selectedGroups } = req.body;
  if (!Array.isArray(selectedGroups)) {
    return res.status(400).json({ error: 'selectedGroups debe ser un array' });
  }
  saveSettings({ selectedGroups });
  res.json({ success: true });
});

app.post('/api/upload', upload.single('excelFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  try {
    const catalog = processExcelBuffer(req.file.buffer);
    if (catalog.length === 0) {
      return res.status(400).json({ error: 'El archivo Excel no contiene propiedades legibles.' });
    }

    saveCatalogToDisk(catalog);
    propertyCatalog = catalog;
    res.json({ success: true, count: catalog.length });
  } catch (error: any) {
    console.error('Error al procesar subida de Excel:', error);
    res.status(500).json({ error: error.message || 'Error interno al procesar el archivo.' });
  }
});

app.get('/api/catalog', (req, res) => {
  res.json({ count: propertyCatalog.length });
});

app.get('/api/matches', (req, res) => {
  res.json({ matches: recentMatches });
});

/**
 * Procesa un mensaje calificado de WhatsApp
 */
async function processIncomingMessage(body: string, sender: string, groupName: string, senderPhone: string) {
  // 1. Filtrado local ultra-rápido (cero costo de API)
  if (!isRealEstateRequest(body)) {
    return;
  }

  console.log(`\n--------------------------------------------------`);
  console.log(`[PRE-FILTRO MATCH] Pedido detectado de ${sender} en [${groupName}]`);
  console.log(`Contenido: "${body}"`);
  console.log(`Ejecutando Agente 1 (Extractor de Entidades)...`);

  // 2. Agente 1: Extraer entidades estructuradas básicas
  const requestEntities = await extractRealEstateRequest(body);
  console.log(`[AGENTE 1 - ENTIDADES] JSON generado:`, JSON.stringify(requestEntities, null, 2));

  if (requestEntities.operacion === 'desconocido') {
    console.log('[PROCESO] Cancelado: Operación desconocida o no clasificada como pedido inmobiliario.');
    return;
  }

  // Validar si se extrajo ubicación
  let zoneIntent: ZoneIntentRequest | undefined = undefined;
  const hasUbicacion = requestEntities.zonas && requestEntities.zonas.length > 0;

  if (hasUbicacion) {
    console.log(`Ubicación detectada. Ejecutando Agente 2 (Geolocalizador e Intenciones)...`);
    zoneIntent = await extractZoneIntent(body, requestEntities.operacion);
    console.log(`[AGENTE 2 - GEO INTENT] JSON generado:`, JSON.stringify(zoneIntent, null, 2));
  } else {
    console.log(`No se detectó ubicación en la consulta. Se saltea el Agente 2.`);
  }

  // 3. Ejecutar algoritmo de matching contra la cartera local en memoria
  console.log(`[MATCHER] Comparando con ${propertyCatalog.length} propiedades de la cartera...`);

  let matchesFoundCount = 0;

  const matchedPropertiesList: { property: Property; score: number }[] = [];

  for (const property of propertyCatalog) {
    const matchResult = checkMatch(requestEntities, property, zoneIntent);

    if (matchResult.isMatch) {
      matchesFoundCount++;
      matchedPropertiesList.push({ property, score: matchResult.score });
      console.log(`[¡MATCH ENCONTRADO!]:`);
      console.log(` - Propiedad: ${property.domicilio} (Precio: ${property.moneda} ${property.precio})`);
      console.log(` - Score de coincidencia: ${matchResult.score}%`);
      console.log(` - Detalles:`, matchResult.reasons.join(', '));

      const matchDetailsText = `Score: ${matchResult.score}%\n\nDetalles:\n${matchResult.reasons.join('\n')}`;

      // 4. Guardar coincidencia en Google Sheets (para persistencia)
      await saveMatch(body, sender, property, matchDetailsText);

      // 5. Guardar en lista de matches recientes en memoria para mostrar en el Dashboard
      const matchFecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' });
      recentMatches.unshift({
        fecha: matchFecha,
        originalText: body,
        contactSender: sender,
        groupName: groupName,
        property,
        matchDetails: matchDetailsText
      });

      // Mantener los últimos 50 matches
      if (recentMatches.length > 50) {
        recentMatches.pop();
      }
    }
  }

  if (matchesFoundCount === 0) {
    console.log(`[MATCHER] No se encontraron coincidencias en la cartera para este pedido.`);
  } else {
    // 6. Enviar notificación al propio WhatsApp del usuario conectado
    const matchIntro = matchesFoundCount === 1 
      ? `🏠 *¡${matchesFoundCount} MATCH ENCONTRADO!*`
      : `🏠 *¡${matchesFoundCount} MATCHES ENCONTRADOS!*`;

    const propDetails = matchedPropertiesList.map((m, idx) => {
      const waLink = m.property.contacto ? `https://wa.me/${m.property.contacto.replace(/\D/g, '')}` : '';
      const contactInfo = waLink ? `[${m.property.contacto}](${waLink})` : (m.property.contacto || 'No especificado');
      return `*${idx + 1}. ${m.property.domicilio}* (${m.property.sheetName})
   • Precio: *${m.property.moneda} ${m.property.precio}*
   • Zona: ${m.property.zona}
   • Contacto Captador: ${contactInfo}`;
    }).join('\n\n');

    const notificationText = `${matchIntro}
En el grupo: _${groupName}_

*Pedido:*
"${body.substring(0, 200)}${body.length > 200 ? '...' : ''}"

*Cliente (Solicitante):*
👤 ${sender}
📱 Chat directo: wa.me/${senderPhone}

*Propiedades Coincidentes:*
${propDetails}`;

    await sendWhatsAppNotification(notificationText);
  }
  console.log(`--------------------------------------------------\n`);
}

/**
 * Función principal
 */
async function main() {
  console.log('Iniciando HouseMatch MVP con Dashboard...');
  
  // Diagnóstico de entorno para Railway/Puppeteer
  console.log('[DIAGNOSTIC] PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
  try {
    const { execSync } = require('child_process');
    const pathChromium = execSync('command -v chromium || which chromium').toString().trim();
    console.log('[DIAGNOSTIC] Ubicación de chromium en sistema:', pathChromium);
  } catch (e: any) {
    console.warn('[DIAGNOSTIC] Falló comando al buscar chromium:', e.message);
  }

  // Cargar catálogo inicialmente desde disco
  propertyCatalog = loadCatalogFromDisk();
  console.log(`Catálogo inicializado con ${propertyCatalog.length} propiedades.`);

  // Iniciar cliente de WhatsApp
  startWhatsAppClient({
    onMessage: async (message, senderName, groupName, senderPhone) => {
      await processIncomingMessage(message.body, senderName, groupName, senderPhone);
    }
  });

  // Levantar servidor web
  app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`DASHBOARD DISPONIBLE EN: http://localhost:${PORT}`);
    console.log(`=========================================\n`);
  });
}

// Iniciar aplicación
main().catch((error) => {
  console.error('Fallo crítico al iniciar la aplicación:', error);
});
