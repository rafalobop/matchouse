import { GoogleGenAI } from '@google/genai';
import { OpenAI } from 'openai';
import { config } from '../config/env';

// --- DEFINICIONES DE TIPOS ---

export interface ExtractedRealEstateRequest {
  operacion: 'venta' | 'alquiler' | 'desconocido';
  tipo_propiedad: 'departamento' | 'casa' | 'terreno' | 'local' | 'oficina' | 'otro';
  zonas: string[];
  presupuesto_max: number | null;
  moneda: 'USD' | 'ARS' | 'desconocido';
  dormitorios: number | null;
  caracteristicas_clave: string[];
}

export interface ZoneIntentRequest {
  zona_id: 'ZONA_MATE_DE_LUNA' | 'ZONA_YERBA_BUENA' | 'ZONA_CENTRO_BARRIO_NORTE' | 'DESCONOCIDO';
  texto_ubicacion_original: string;
  dormitorios_min: number | null;
  caracteristicas_claves: string[];
  operacion: 'ALQUILER' | 'COMPRA' | 'DESCONOCIDO';
}

// --- INTERFAZ DEL PATRÓN STRATEGY ---

export interface AIStrategy {
  name: string;
  extractRealEstateRequest(messageTexto: string, systemInstruction: string): Promise<any>;
  extractZoneIntent(messageTexto: string, systemInstruction: string): Promise<any>;
}

// --- ESTRATEGIAS CONCRETAS ---

class GeminiStrategy implements AIStrategy {
  readonly name = 'Google Gemini (gemini-2.5-flash-lite)';
  private ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  async extractRealEstateRequest(messageTexto: string, systemInstruction: string): Promise<any> {
    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: `Analiza este mensaje: "${messageTexto}"`,
      config: {
        systemInstruction,
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
    return JSON.parse(responseText.trim());
  }

  async extractZoneIntent(messageTexto: string, systemInstruction: string): Promise<any> {
    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: `Clasifica la zona e intención de este mensaje: "${messageTexto}"`,
      config: {
        systemInstruction,
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
    return JSON.parse(responseText.trim());
  }
}

class OpenAIStrategy implements AIStrategy {
  readonly name = 'OpenAI (gpt-4o-mini)';
  private openai = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;

  async extractRealEstateRequest(messageTexto: string, systemInstruction: string): Promise<any> {
    if (!this.openai) {
      throw new Error('OpenAI API key no está configurada.');
    }

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: `Analiza este mensaje: "${messageTexto}"` }
      ],
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Respuesta de OpenAI vacía');
    return JSON.parse(content.trim());
  }

  async extractZoneIntent(messageTexto: string, systemInstruction: string): Promise<any> {
    if (!this.openai) {
      throw new Error('OpenAI API key no está configurada.');
    }

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: `Clasifica la zona e intención de este mensaje: "${messageTexto}"` }
      ],
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Respuesta de OpenAI vacía');
    return JSON.parse(content.trim());
  }
}

// --- CONTEXT / MANAGER DE ESTRATEGIAS DE IA ---

class AIExtractorContext {
  private strategies: AIStrategy[] = [];

  constructor() {
    // Definimos el orden de prioridades de las estrategias
    this.strategies.push(new GeminiStrategy());
    if (config.openaiApiKey) {
      this.strategies.push(new OpenAIStrategy());
    } else {
      console.warn('[AI CONTEXT] OpenAI no está disponible (falta OPENAI_API_KEY).');
    }
  }

  async extractRealEstateRequest(messageTexto: string): Promise<ExtractedRealEstateRequest> {
    for (const strategy of this.strategies) {
      try {
        console.log(`[AI STRATEGY] Intentando Extracción Básica con: ${strategy.name}`);
        const rawResult = await strategy.extractRealEstateRequest(messageTexto, SYSTEM_INSTRUCTIONS_AGENT1);
        return normalizeAgent1(rawResult);
      } catch (error) {
        console.warn(`[AI STRATEGY] Falla en estrategia ${strategy.name}. Intentando fallback... Error:`, error);
      }
    }

    console.error('[AI STRATEGY] Todas las estrategias de extracción fallaron.');
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

  async extractZoneIntent(messageTexto: string): Promise<ZoneIntentRequest> {
    for (const strategy of this.strategies) {
      try {
        console.log(`[AI STRATEGY] Intentando Geo Comparación con: ${strategy.name}`);
        const rawResult = await strategy.extractZoneIntent(messageTexto, SYSTEM_INSTRUCTIONS_AGENT2);
        return normalizeAgent2(rawResult);
      } catch (error) {
        console.warn(`[AI STRATEGY] Falla en estrategia ${strategy.name}. Intentando fallback... Error:`, error);
      }
    }

    console.error('[AI STRATEGY] Todas las estrategias de zona fallaron.');
    return {
      zona_id: 'DESCONOCIDO',
      texto_ubicacion_original: '',
      dormitorios_min: null,
      caracteristicas_claves: [],
      operacion: 'DESCONOCIDO'
    };
  }
}

// --- PROMPTS DE INSTRUCCIONES COMPARTIDOS ---

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

// --- FUNCIONES DE NORMALIZACIÓN COMPARTIDAS ---

function normalizeAgent1(parsed: any): ExtractedRealEstateRequest {
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

  return {
    operacion: parsed.operacion,
    tipo_propiedad: parsed.tipo_propiedad,
    zonas: parsed.zonas,
    presupuesto_max: parsed.presupuesto_max !== undefined ? parsed.presupuesto_max : null,
    moneda: parsed.moneda,
    dormitorios: parsed.dormitorios !== undefined ? parsed.dormitorios : null,
    caracteristicas_clave: parsed.caracteristicas_clave
  };
}

function normalizeAgent2(parsed: any): ZoneIntentRequest {
  if (parsed.zona_id) {
    parsed.zona_id = String(parsed.zona_id).toUpperCase() as any;
    if (!['ZONA_MATE_DE_LUNA', 'ZONA_YERBA_BUENA', 'ZONA_CENTRO_BARRIO_NORTE', 'DESCONOCIDO'].includes(parsed.zona_id)) {
      parsed.zona_id = 'DESCONOCIDO';
    }
  } else {
    parsed.zona_id = 'DESCONOCIDO';
  }

  if (parsed.operacion) {
    parsed.operacion = String(parsed.operacion).toUpperCase() as any;
    if (!['ALQUILER', 'COMPRA', 'DESCONOCIDO'].includes(parsed.operacion)) {
      parsed.operacion = 'DESCONOCIDO';
    }
  } else {
    parsed.operacion = 'DESCONOCIDO';
  }

  if (!Array.isArray(parsed.caracteristicas_claves)) {
    parsed.caracteristicas_claves = [];
  }

  return {
    zona_id: parsed.zona_id,
    texto_ubicacion_original: parsed.texto_ubicacion_original || '',
    dormitorios_min: parsed.dormitorios_min !== undefined ? parsed.dormitorios_min : null,
    caracteristicas_claves: parsed.caracteristicas_claves,
    operacion: parsed.operacion
  };
}

// --- INSTANCIACIÓN DEL CONTEXTO Y EXPORTS PÚBLICOS ---

const aiContext = new AIExtractorContext();

export async function extractRealEstateRequest(messageTexto: string): Promise<ExtractedRealEstateRequest> {
  return aiContext.extractRealEstateRequest(messageTexto);
}

export async function extractZoneIntent(messageTexto: string): Promise<ZoneIntentRequest> {
  return aiContext.extractZoneIntent(messageTexto);
}
