import { isRealEstateRequest } from './utils/filter';
import { checkMatch } from './utils/matcher';
import { ExtractedRealEstateRequest, ZoneIntentRequest } from './services/ai';
import { Property } from './services/sheets';

// ... (Rest of imports and mockCartera are preserved)

// 1. Base de datos de cartera simulada
const mockCartera: Property[] = [
  {
    domicilio: 'Av. Aconquija 1200',
    pisoLote: 'PB - B',
    precio: 350,
    moneda: 'USD',
    expensas: 25000,
    dormitorios: 1,
    caracteristicas: 'Departamento planta baja con cochera, patio chico, sin pileta, cocina equipada',
    contacto: 'Juan Pérez - 3815551234',
    zona: 'Yerba Buena',
    operacion: 'alquiler',
    tipo_propiedad: 'departamento',
    sheetName: 'Alquileres Yerba Buena'
  },
  {
    domicilio: 'Lomas de Yerba Buena',
    pisoLote: 'Lote 45',
    precio: 45000,
    moneda: 'USD',
    expensas: 0,
    dormitorios: 0,
    caracteristicas: 'Terreno plano de 450m2 listo para construir, apto credito, todos los servicios',
    contacto: 'María López - 3815555678',
    zona: 'Yerba Buena',
    operacion: 'venta',
    tipo_propiedad: 'terreno',
    sheetName: 'Ventas Yerba Buena'
  },
  {
    domicilio: 'Muñecas 800',
    pisoLote: 'Piso 5 - A',
    precio: 280000,
    moneda: 'ARS',
    expensas: 35000,
    dormitorios: 2,
    caracteristicas: 'Dpto de 2 dormitorios en Barrio Norte, balcón al frente, cochera techada, pileta y SUM en terraza',
    contacto: 'Carlos Gómez - 3815559012',
    zona: 'San Miguel de Tucumán',
    operacion: 'alquiler',
    tipo_propiedad: 'departamento',
    sheetName: 'Alquileres San Miguel de Tucumán'
  },
  {
    domicilio: 'Laprida 400',
    pisoLote: 'Piso 2',
    precio: 85000,
    moneda: 'USD',
    expensas: 40000,
    dormitorios: 3,
    caracteristicas: 'Amplio departamento de 3 dorms, cocina comedor, living, dependencia de servicio, apto credito, cochera',
    contacto: 'Ana Ruiz - 3815553456',
    zona: 'San Miguel de Tucumán',
    operacion: 'venta',
    tipo_propiedad: 'departamento',
    sheetName: 'Ventas San Miguel de Tucumán'
  }
];

// 2. Mensajes de prueba simulando chat grupal
const mockMessages = [
  {
    id: 1,
    sender: 'Esteban (+549381...)',
    text: 'Hola colegas, buenas tardes! Alguien tiene departamento en alquiler por Yerba Buena? Busco para cliente de 1 dorm con cochera. Max 400 usd. Gracias!',
    expectedRequest: true
  },
  {
    id: 2,
    sender: 'InmoTuc (+549381...)',
    text: 'DISPONIBLE: Oficina céntrica en Alquiler, excelente ubicación sobre calle 25 de Mayo al 300. Consultas por privado.',
    expectedRequest: false // Es una oferta, no un pedido
  },
  {
    id: 3,
    sender: 'Sonia (+549381...)',
    text: 'Buen dia! Necesito comprar lote en YB, zona Marcos Paz o Lomas. Presupuesto max u$s 50.000. Debe ser apto credito.',
    expectedRequest: true
  },
  {
    id: 4,
    sender: 'Pedro (+549381...)',
    text: 'Alguien sabe a que hora abre el colegio de martilleros mañana? Gracias.',
    expectedRequest: false // Spam / consulta no comercial
  },
  {
    id: 5,
    sender: 'Gaby (+549381...)',
    text: 'Colegas busco dpto en alquiler temporario de 2 dorms en Barrio Norte o Centro. Que tenga pileta si o si. Pago en pesos.',
    expectedRequest: true
  }
];

// 3. Entidades simuladas correspondientes a las búsquedas exitosas (paso intermedio que haría Gemini)
const mockExtractedEntities: Record<number, ExtractedRealEstateRequest> = {
  1: {
    operacion: 'alquiler',
    tipo_propiedad: 'departamento',
    zonas: ['Yerba Buena'],
    presupuesto_max: 400,
    moneda: 'USD',
    dormitorios: 1,
    caracteristicas_clave: ['cochera'],
    country: 'indiferente'
  },
  3: {
    operacion: 'venta',
    tipo_propiedad: 'terreno',
    zonas: ['Yerba Buena'],
    presupuesto_max: 50000,
    moneda: 'USD',
    dormitorios: null,
    caracteristicas_clave: ['apto credito'],
    country: 'indiferente'
  },
  5: {
    operacion: 'alquiler',
    tipo_propiedad: 'departamento',
    zonas: ['San Miguel de Tucumán'],
    presupuesto_max: null,
    moneda: 'ARS',
    dormitorios: 2,
    caracteristicas_clave: ['pileta'],
    country: 'indiferente'
  }
};

// 4. Intenciones de zonas simuladas para el Agente 2
const mockZoneIntents: Record<number, ZoneIntentRequest> = {
  1: {
    zona_id: 'YERBA_BUENA',
    texto_ubicacion_original: 'Yerba Buena',
    dormitorios_min: 1,
    caracteristicas_claves: ['cochera'],
    operacion: 'ALQUILER'
  },
  3: {
    zona_id: 'YERBA_BUENA',
    texto_ubicacion_original: 'YB, zona Marcos Paz o Lomas',
    dormitorios_min: null,
    caracteristicas_claves: ['apto credito'],
    operacion: 'COMPRA'
  },
  5: {
    zona_id: 'BARRIO_NORTE',
    texto_ubicacion_original: 'Barrio Norte o Centro',
    dormitorios_min: 2,
    caracteristicas_claves: ['pileta'],
    operacion: 'ALQUILER'
  }
};

function runTestPipeline() {
  console.log('=== INICIANDO DRY-RUN DEL PIPELINE HOUSEMATCH ===\n');

  console.log(`[CATÁLOGO] ${mockCartera.length} propiedades simuladas en cartera.`);

  mockMessages.forEach(msg => {
    console.log(`\n--------------------------------------------------`);
    console.log(`[MENSAJE ENTRANTE] Remitente: ${msg.sender}`);
    console.log(`Texto: "${msg.text}"`);

    // Prueba de Pre-Filtro Local
    const isRequest = isRealEstateRequest(msg.text);
    console.log(`-> ¿Es un pedido comercial? ${isRequest ? 'SÍ (Procesar)' : 'NO (Ignorar)'}`);

    if (isRequest !== msg.expectedRequest) {
      console.warn(`⚠️ [ADVERTENCIA] Mismatch en pre-filtro. Esperado: ${msg.expectedRequest}, Obtenido: ${isRequest}`);
    }

    if (!isRequest) {
      console.log('--------------------------------------------------');
      return;
    }

    // Obtener las entidades simuladas (en producción esto vendría de Gemini)
    const entities = mockExtractedEntities[msg.id];
    if (!entities) {
      console.log('No hay entidades simuladas configuradas para este mensaje de prueba.');
      console.log('--------------------------------------------------');
      return;
    }

    const zoneIntent = mockZoneIntents[msg.id];

    console.log('\n[SIMULACIÓN GEMINI - AGENTE 1] Entidades básicas extraídas:');
    console.log(JSON.stringify(entities, null, 2));

    if (zoneIntent) {
      console.log('\n[SIMULACIÓN GEMINI - AGENTE 2] Geolocalizador e Intención de Zona:');
      console.log(JSON.stringify(zoneIntent, null, 2));
    }

    // Ejecutar comparación
    console.log('\n[MOTOR DE MATCH] Buscando coincidencias en la cartera...');
    let matchCount = 0;

    mockCartera.forEach(property => {
      const matchResult = checkMatch(entities, property, zoneIntent);
      if (matchResult.isMatch) {
        matchCount++;
        console.log(`\n🎉 MATCH ENCONTRADO (${matchResult.score}%):`);
        console.log(`   - Propiedad: ${property.domicilio} (Pestaña: ${property.sheetName})`);
        console.log(`   - Precio: ${property.moneda} ${property.precio}`);
        console.log(`   - Contacto Captador: ${property.contacto}`);
        console.log(`   - Detalles:`);
        matchResult.reasons.forEach(r => console.log(`     * ${r}`));
      }
    });

    if (matchCount === 0) {
      console.log('❌ No se encontraron coincidencias para este pedido.');
    }
    console.log('--------------------------------------------------');
  });

  console.log('\n=== DRY-RUN DEL PIPELINE FINALIZADO ===');
}

// Ejecutar
runTestPipeline();
