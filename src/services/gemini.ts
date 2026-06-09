import { GoogleGenAI } from '@google/genai';
import { config } from '../config/env';

// --- AGENTE 1: EXTRACTOR DE ENTIDADES BÁSICAS ---

export interface ExtractedRealEstateRequest {
  operacion: 'venta' | 'alquiler' | 'desconocido';
  tipo_propiedad: 'departamento' | 'casa' | 'terreno' | 'local' | 'oficina' | 'otro';
  zonas: string[];
  presupuesto_max: number | null;
  moneda: 'USD' | 'ARS' | 'desconocido';
  dormitorios: number | null;
  caracteristicas_clave: string[];
}

// --- AGENTE 2: GEOLOCALIZADOR E INTENCIONES DETALLADAS ---

export interface ZoneIntentRequest {
  zona_id: 'ZONA_MATE_DE_LUNA' | 'ZONA_YERBA_BUENA' | 'ZONA_CENTRO_BARRIO_NORTE' | 'DESCONOCIDO';
  texto_ubicacion_original: string;
  dormitorios_min: number | null;
  caracteristicas_claves: string[];
  operacion: 'ALQUILER' | 'COMPRA' | 'DESCONOCIDO';
}

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

// System Instructions - Agente 1 (Extractor General)
const SYSTEM_INSTRUCTIONS_AGENT1 = `
Eres un asistente experto en el mercado inmobiliario de Tucumán, Argentina.
Tu tarea es extraer entidades estructuradas a partir de mensajes informales de chat de WhatsApp de agentes inmobiliarios.

Debes responder ÚNICAMENTE con un objeto JSON válido que siga exactamente el esquema especificado, sin textos adicionales, comentarios, campos duplicados ni claves mal formadas.

Sigue estrictamente estas reglas de negocio:

1. OPERACIÓN:
   - Identifica si el pedido es de "venta" o "alquiler". Si no dice explícitamente uno de los dos, revisa si está la palabra "Busco", "Necesito", "alguien tiene", busca un monto (e.g. 40000 usd), un "presupuesto" o "hasta XXX" (e.g. 100000 usd) y setea ante estas coincidencias secundarias, "venta" (en minúsculas).
   - El campo "operacion" DEBE ser una de estas tres opciones en minúsculas: "venta", "alquiler" o "desconocido". Nunca utilices valores en mayúsculas como "DESCONOCIDO".

2. TIPO DE PROPIEDAD:
   - Debe ser uno de: "departamento", "casa", "terreno", "local", "oficina", "otro".
   - Mapea abreviaciones: "dpto", "depto", "departamento" -> "departamento"; "lote" -> "terreno".

3. ZONAS (Mapeo Local):
   - Mapea los barrios locales a los municipios principales:
     * "Barrio Norte", "Barrio Sur", "Centro", "SMT", "San Miguel", "B° Norte", "B° Sur" -> "San Miguel de Tucumán"
     * "Yerba Buena", "YB", "El Corte", "Marcos Paz", "San José" -> "Yerba Buena"
     * "Tafí Viejo", "Lomas de Tafí" -> "Tafí Viejo"
   - Si se mencionan múltiples zonas, agrégalas al array.

4. PRESUPUESTO MÁXIMO Y MONEDA:
   - Extrae el monto numérico máximo y la moneda ("USD", "ARS". Si no especifica, analiza qué tipo de operación es la que se busca: si es venta, setea USD, si es alquiler, setea ARS (o pesos)).
   - Ejemplos:
     * "max 300 usd" / "hasta 300 dólares" -> presupuesto_max: 300, moneda: "USD"
     * "hasta 250 mil pesos" / "presupuesto 250k" -> presupuesto_max: 250000, moneda: "ARS"
     * Si no se especifica presupuesto, deja presupuesto_max en null y, en moneda, analiza el tipo de operación que se está haciendo: si es compra/venta, setea USD, si es alquiler ARS.

5. DORMITORIOS:
   - Extrae el número entero de dormitorios requeridos:
     * "monoambiente", "estudio" -> 0
     * "1 dorm", "un dormitorio" -> 1
     * "2 dorms", "dos dormitorios" -> 2

6. CARACTERÍSTICAS CLAVE:
   - Extrae un array de strings en minúsculas con palabras clave relevantes:
     * "cochera", "garaje", "estacionamiento" -> "cochera"
     * "pileta", "piscina" -> "pileta"
     * "jardín", "patio" -> "jardin"
     * "seguridad", "guardia" -> "seguridad"
     * "apta crédito", "apto credito" -> "apto credito"
     * "balcón", "balcon" -> "balcon"
     * "amenities", "sum" -> "amenities"
     * "amueblado", "amob" -> "amueblado"
`;

// System Instructions - Agente 2 (Geolocalizador e Intenciones Específicas)
const SYSTEM_INSTRUCTIONS_AGENT2 = `
Sos un Agente Extractor de Intenciones Inmobiliarias ultra preciso. Tu único objetivo es leer mensajes de texto provenientes de grupos de WhatsApp de clientes que buscan propiedades y transformarlos en un objeto JSON estricto. No debés incluir explicaciones, introducciones ni bloques de código Markdown, solo el objeto JSON válido.

Zonas Geográficas Permitidas
Debés clasificar la ubicación del mensaje únicamente en uno de los siguientes IDs de zona permitidos. Si el mensaje menciona una calle, avenida, barrio o country que pertenezca a esa zona, usá el ID correspondiente:

- ZONA_MATE_DE_LUNA: Si menciona Av. Mate de Luna, Parque Avellaneda, esquinas o paralelas cercanas a la avenida (alturas del 1600 al 4700).
- ZONA_YERBA_BUENA: Si menciona Yerba Buena, Av. Perón, Av. Aconquija, o countries de esa zona (La Arboledas, San Patricio, etc.).
- ZONA_CENTRO_BARRIO_NORTE: Si menciona calles del centro (Santiago, 9 de Julio, Corrientes, Laprida, etc.).
- DESCONOCIDO: Si no menciona ninguna ubicación o no podés asociarla con total seguridad a las anteriores.

Esquema de Salida (JSON)
Deberás devolver exactamente esta estructura:
{
  "zona_id": "ZONA_MATE_DE_LUNA" | "ZONA_YERBA_BUENA" | "ZONA_CENTRO_BARRIO_NORTE" | "DESCONOCIDO",
  "texto_ubicacion_original": "string con lo que escribió el usuario sobre la ubicación",
  "dormitorios_min": número entero (si pide '3 dorm' es 3. Si no especifica, poner null),
  "caracteristicas_claves": ["array", "de", "strings", "como", "jardin", "pileta", "cochera", "amoblado"],
  "operacion": "ALQUILER" | "COMPRA" | "DESCONOCIDO"
}
`;

/**
 * Agente 1: Analiza el mensaje y extrae los datos básicos estruturados.
 */
export async function extractRealEstateRequest(messageTexto: string): Promise<ExtractedRealEstateRequest> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: `Analiza este mensaje: "${messageTexto}"`,
      config: {
        systemInstruction: SYSTEM_INSTRUCTIONS_AGENT1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            operacion: { type: 'STRING', enum: ['venta', 'alquiler', 'desconocido'] },
            tipo_propiedad: { type: 'STRING', enum: ['departamento', 'casa', 'terreno', 'local', 'oficina', 'otro'] },
            zonas: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: 'Zonas normalizadas'
            },
            presupuesto_max: { type: 'INTEGER', nullable: true },
            moneda: { type: 'STRING', enum: ['USD', 'ARS', 'desconocido'] },
            dormitorios: { type: 'INTEGER', nullable: true },
            caracteristicas_clave: { type: 'ARRAY', items: { type: 'STRING' } }
          },
          required: ['operacion', 'tipo_propiedad', 'zonas', 'presupuesto_max', 'moneda', 'dormitorios', 'caracteristicas_clave']
        }
      }
    });

    const responseText = response.text;
    if (!responseText) throw new Error('Respuesta de Gemini vacía');
    
    const parsed = JSON.parse(responseText.trim()) as ExtractedRealEstateRequest;
    
    // Normalizar robustamente la respuesta de Gemini para prevenir roturas en el matcher
    if (parsed.operacion) {
      parsed.operacion = String(parsed.operacion).toLowerCase() as any;
      if (!['venta', 'alquiler', 'desconocido'].includes(parsed.operacion)) {
        parsed.operacion = 'desconocido';
      }
    } else {
      parsed.operacion = 'desconocido';
    }

    if (parsed.tipo_propiedad) {
      parsed.tipo_propiedad = String(parsed.tipo_propiedad).toLowerCase() as any;
      if (!['departamento', 'casa', 'terreno', 'local', 'oficina', 'otro'].includes(parsed.tipo_propiedad)) {
        parsed.tipo_propiedad = 'otro';
      }
    } else {
      parsed.tipo_propiedad = 'otro';
    }

    if (parsed.moneda) {
      parsed.moneda = String(parsed.moneda).toUpperCase() as any;
      if (!['USD', 'ARS', 'desconocido'].includes(parsed.moneda)) {
        parsed.moneda = 'desconocido';
      }
    } else {
      parsed.moneda = 'desconocido';
    }

    if (!Array.isArray(parsed.zonas)) {
      parsed.zonas = [];
    }

    if (!Array.isArray(parsed.caracteristicas_clave)) {
      parsed.caracteristicas_clave = [];
    }

    return parsed;
  } catch (error) {
    console.error('Error en Agente 1 (Extracción Básica):', error);
    return {
      operacion: 'desconocido',
      tipo_propiedad: 'otro',
      zonas: [],
      presupuesto_max: null,
      moneda: 'desconocido',
      dormitorios: null,
      caracteristicas_clave: []
    };
  }
}

/**
 * Agente 2: Geocomparador de intenciones de zona.
 */
export async function extractZoneIntent(messageTexto: string): Promise<ZoneIntentRequest> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: `Clasifica la zona e intención de este mensaje: "${messageTexto}"`,
      config: {
        systemInstruction: SYSTEM_INSTRUCTIONS_AGENT2,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            zona_id: { type: 'STRING', enum: ['ZONA_MATE_DE_LUNA', 'ZONA_YERBA_BUENA', 'ZONA_CENTRO_BARRIO_NORTE', 'DESCONOCIDO'] },
            texto_ubicacion_original: { type: 'STRING' },
            dormitorios_min: { type: 'INTEGER', nullable: true },
            caracteristicas_claves: { type: 'ARRAY', items: { type: 'STRING' } },
            operacion: { type: 'STRING', enum: ['ALQUILER', 'COMPRA', 'DESCONOCIDO'] }
          },
          required: ['zona_id', 'texto_ubicacion_original', 'dormitorios_min', 'caracteristicas_claves', 'operacion']
        }
      }
    });

    const responseText = response.text;
    if (!responseText) throw new Error('Respuesta de Gemini vacía');
    return JSON.parse(responseText.trim()) as ZoneIntentRequest;
  } catch (error) {
    console.error('Error en Agente 2 (Geo Comparación):', error);
    return {
      zona_id: 'DESCONOCIDO',
      texto_ubicacion_original: '',
      dormitorios_min: null,
      caracteristicas_claves: [],
      operacion: 'DESCONOCIDO'
    };
  }
}
