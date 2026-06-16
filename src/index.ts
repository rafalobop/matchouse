import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { startWhatsAppClient, loadSettings, saveSettings, getActiveGroups, whatsappStatus, restartWhatsAppClient } from './services/whatsapp';
import { Property } from './services/sheets';
import { loadCatalogFromDisk, saveCatalogToDisk, processExcelBuffer } from './services/excel';
import { coordinator } from './services/coordinator';
import { messageQueue } from './utils/queue';

// In-memory property catalog
let propertyCatalog: Property[] = [];

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

app.post('/api/upload', upload.single('excelFile'), async (req, res) => {
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
    coordinator.setCatalog(catalog);
    
    const { syncPropertiesToDatabase } = require('./services/sheets');
    await syncPropertiesToDatabase(catalog);

    res.json({ success: true, count: catalog.length });
  } catch (error: any) {
    console.error('Error al procesar subida de Excel:', error);
    res.status(500).json({ error: error.message || 'Error interno al procesar el archivo.' });
  }
});

app.get('/api/catalog', (req, res) => {
  res.json({ count: propertyCatalog.length });
});

app.get('/api/matches', async (req, res) => {
  const { supabase } = require('./services/supabase');
  try {
    const { data: dbMatches, error } = await supabase
      .from('Match')
      .select(`
        *,
        property:Property(*),
        message:Message(*)
      `)
      .order('fecha', { ascending: false })
      .limit(50);

    if (error) throw error;

    const mappedMatches = dbMatches.map((m: any) => ({
      id: m.id,
      fecha: new Date(m.fecha).toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' }),
      originalText: m.message.body,
      contactSender: m.message.sender,
      groupName: m.message.groupName,
      property: {
        domicilio: m.property.domicilio,
        pisoLote: m.property.pisoLote || '',
        precio: m.property.precio,
        moneda: m.property.moneda,
        expensas: m.property.expensas,
        dormitorios: m.property.dormitorios,
        caracteristicas: m.property.caracteristicas || '',
        contacto: m.property.contacto || '',
        zona: m.property.zona,
        operacion: m.property.operacion,
        tipo_propiedad: m.property.tipoPropiedad,
        sheetName: m.property.sheetName
      },
      matchDetails: m.matchDetails,
      userReviewStatus: m.userReviewStatus || 'PENDING',
      feedbackReason: m.feedbackReason || null
    }));

    res.json({ matches: mappedMatches });
  } catch (error: any) {
    console.error('Error al recuperar matches de la base de datos:', error);
    res.json({ matches: coordinator.getRecentMatches() });
  }
});

app.post('/api/matches/:id/feedback', async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body;
  const { supabase } = require('./services/supabase');

  if (!status || !['ACCEPTED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'El estado debe ser ACCEPTED o REJECTED' });
  }

  try {
    const { error } = await supabase
      .from('Match')
      .update({
        userReviewStatus: status,
        feedbackReason: status === 'REJECTED' ? (reason || 'No especificado') : null
      })
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error al actualizar el feedback de match:', error);
    res.status(500).json({ error: error.message || 'Error interno al guardar feedback.' });
  }
});

// La lógica de procesamiento de mensajes entrantes fue delegada al Agente Coordinador (coordinator.ts)

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

  const { supabase } = require('./services/supabase');
  const { syncPropertiesToDatabase } = require('./services/sheets');
  
  let propertiesFromDb: any[] = [];
  try {
    const { data, error } = await supabase
      .from('Property')
      .select('*');
      
    if (error) throw error;
    propertiesFromDb = data || [];
  } catch (e) {
    console.warn('[MAIN - SUPABASE] No se pudo recuperar propiedades:', e);
  }

  if (propertiesFromDb.length > 0) {
    console.log(`[MAIN - SUPABASE] Catálogo cargado desde la base de datos (${propertiesFromDb.length} propiedades).`);
    propertyCatalog = propertiesFromDb.map(p => ({
      domicilio: p.domicilio,
      pisoLote: p.pisoLote || '',
      precio: p.precio,
      moneda: p.moneda as any,
      expensas: p.expensas,
      dormitorios: p.dormitorios,
      caracteristicas: p.caracteristicas || '',
      contacto: p.contacto || '',
      zona: p.zona,
      operacion: p.operacion as any,
      tipo_propiedad: p.tipoPropiedad as any,
      sheetName: p.sheetName,
      latitud: p.latitud || undefined,
      longitud: p.longitud || undefined
    }));
  } else {
    propertyCatalog = loadCatalogFromDisk();
    console.log(`[MAIN] Catálogo local inicializado con ${propertyCatalog.length} propiedades.`);
    if (propertyCatalog.length > 0) {
      await syncPropertiesToDatabase(propertyCatalog);
    }
  }
  coordinator.setCatalog(propertyCatalog);

  // Iniciar cliente de WhatsApp
  startWhatsAppClient({
    onMessage: async (message, senderName, groupName, senderPhone) => {
      messageQueue.enqueue(async () => {
        await coordinator.handleIncomingMessage(message.body, senderName, groupName, senderPhone, message.id);
      });
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
