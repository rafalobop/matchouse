import { isRealEstateRequest } from '../src/utils/filter';
import { checkMatch } from '../src/utils/matcher';
import { ExtractedRealEstateRequest, ZoneIntentRequest } from '../src/services/ai';
import { Property } from '../src/services/excel';
import { assertDevOnly } from './utils/devOnlyGuard';

assertDevOnly('test-pipeline.ts');


// 1. Base de datos de cartera simulada
const mockCartera: Property[] = [
  {
    address: 'Av. Aconquija 1200',
    unit: 'PB - B',
    price: 350,
    currency: 'USD',
    maintenance_fees: 25000,
    bedrooms: 1,
    features: 'Departamento planta baja con cochera, patio chico, sin pileta, cocina equipada',
    contact_info: 'Juan Pérez - 3815551234',
    zone_display_name: 'Yerba Buena',
    operation: 'alquiler',
    property_type: 'departamento',
    sheet_name: 'Alquileres Yerba Buena'
  },
  {
    address: 'Lomas de Yerba Buena',
    unit: 'Lote 45',
    price: 45000,
    currency: 'USD',
    maintenance_fees: 0,
    bedrooms: 0,
    features: 'Terreno plano de 450m2 listo para construir, apto credito, todos los servicios',
    contact_info: 'María López - 3815555678',
    zone_display_name: 'Yerba Buena',
    operation: 'venta',
    property_type: 'terreno',
    sheet_name: 'Ventas Yerba Buena'
  },
  {
    address: 'Muñecas 800',
    unit: 'Piso 5 - A',
    price: 280000,
    currency: 'ARS',
    maintenance_fees: 35000,
    bedrooms: 2,
    features: 'Dpto de 2 dormitorios en Barrio Norte, balcón al frente, cochera techada, pileta y SUM en terraza',
    contact_info: 'Carlos Gómez - 3815559012',
    zone_display_name: 'San Miguel de Tucumán',
    operation: 'alquiler',
    property_type: 'departamento',
    sheet_name: 'Alquileres San Miguel de Tucumán'
  },
  {
    address: 'Laprida 400',
    unit: 'Piso 2',
    price: 85000,
    currency: 'USD',
    maintenance_fees: 40000,
    bedrooms: 3,
    features: 'Amplio departamento de 3 dorms, cocina comedor, living, dependencia de servicio, apto credito, cochera',
    contact_info: 'Ana Ruiz - 3815553456',
    zone_display_name: 'San Miguel de Tucumán',
    operation: 'venta',
    property_type: 'departamento',
    sheet_name: 'Ventas San Miguel de Tucumán'
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
    operation: 'alquiler',
    property_type: 'departamento',
    zones: ['Yerba Buena'],
    max_budget: 400,
    currency: 'USD',
    bedrooms: 1,
    key_features: ['cochera'],
    country: 'indiferente'
  },
  3: {
    operation: 'venta',
    property_type: 'terreno',
    zones: ['Yerba Buena'],
    max_budget: 50000,
    currency: 'USD',
    bedrooms: null,
    key_features: ['apto credito'],
    country: 'indiferente'
  },
  5: {
    operation: 'alquiler',
    property_type: 'departamento',
    zones: ['San Miguel de Tucumán'],
    max_budget: null,
    currency: 'ARS',
    bedrooms: 2,
    key_features: ['pileta'],
    country: 'indiferente'
  }
};

// 4. Intenciones de zonas simuladas para el Agente 2
const mockZoneIntents: Record<number, ZoneIntentRequest> = {
  1: {
    zone_status: 'DEFINIDA',
    zona_ids: ['YERBA_BUENA'],
    zona_nombres: ['Yerba Buena'],
    texto_ubicacion_original: 'Yerba Buena',
    dormitorios_min: 1,
    caracteristicas_claves: ['cochera'],
    operacion: 'ALQUILER'
  },
  3: {
    zone_status: 'DEFINIDA',
    zona_ids: ['YERBA_BUENA'],
    zona_nombres: ['Yerba Buena'],
    texto_ubicacion_original: 'YB, zona Marcos Paz o Lomas',
    dormitorios_min: null,
    caracteristicas_claves: ['apto credito'],
    operacion: 'COMPRA'
  },
  5: {
    zone_status: 'DEFINIDA',
    zona_ids: ['BARRIO_NORTE'],
    zona_nombres: ['Barrio Norte'],
    texto_ubicacion_original: 'Barrio Norte o Centro',
    dormitorios_min: 2,
    caracteristicas_claves: ['pileta'],
    operacion: 'ALQUILER'
  }
};

function runTestPipeline() {
  console.log('=== INICIANDO DRY-RUN DEL PIPELINE BROKAZA ===\n');

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
        console.log(`   - Propiedad: ${property.address} (Pestaña: ${property.sheet_name})`);
        console.log(`   - Precio: ${property.currency} ${property.price}`);
        console.log(`   - Contacto Captador: ${property.contact_info}`);
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
