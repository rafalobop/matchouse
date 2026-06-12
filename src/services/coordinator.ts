import { extractRealEstateRequest, extractZoneIntent, ExtractedRealEstateRequest, ZoneIntentRequest, validateMatch } from './gemini';
import { Property, saveMatch } from './sheets';
import { checkMatch } from '../utils/matcher';
import { sendWhatsAppNotification } from './whatsapp';

export interface PipelineContext {
  messageId?: string;
  body: string;
  sender: string;
  groupName: string;
  senderPhone: string;
  timestamp: Date;
  
  // Resultados de agentes
  extractedData?: ExtractedRealEstateRequest;
  zoneIntent?: ZoneIntentRequest;
  matches?: Array<{ property: Property; score: number }>;
  
  // Estado
  status: 'PENDING' | 'EXTRACTED' | 'GEOLOCATED' | 'MATCHED' | 'NOTIFIED' | 'FAILED';
  errors: string[];
}

export class CoordinatorAgent {
  private recentMatches: any[] = [];
  private propertyCatalog: Property[] = [];

  constructor() {}

  /**
   * Actualiza el catálogo local en memoria utilizado para la comparación
   */
  setCatalog(catalog: Property[]) {
    this.propertyCatalog = catalog;
  }

  /**
   * Obtiene los últimos matches registrados en memoria
   */
  getRecentMatches(): any[] {
    return this.recentMatches;
  }

  /**
   * Orquesta la ejecución secuencial o condicional de los sub-agentes
   */
  async handleIncomingMessage(
    body: string, 
    sender: string, 
    groupName: string, 
    senderPhone: string
  ): Promise<PipelineContext> {
    const context: PipelineContext = {
      body,
      sender,
      groupName,
      senderPhone,
      timestamp: new Date(),
      status: 'PENDING',
      errors: []
    };

    console.log(`\n--------------------------------------------------`);
    console.log(`[COORDINADOR] Iniciando orquestación de pedido de ${sender} en [${groupName}]`);
    console.log(`Contenido: "${body}"`);

    const { prisma } = require('./db');
    let dbMessage: any = null;
    try {
      dbMessage = await prisma.message.create({
        data: {
          body,
          sender,
          groupName,
          senderPhone
        }
      });
    } catch (e) {
      console.warn('[COORDINADOR - DB] No se pudo guardar el mensaje entrante en PostgreSQL:', e);
    }

    try {
      // 1. Agente 1: Extractor de Entidades
      console.log(`[COORDINADOR] Ejecutando Agente 1 (Extractor)...`);
      context.extractedData = await extractRealEstateRequest(body);
      console.log(`[COORDINADOR - AGENTE 1] JSON generado:`, JSON.stringify(context.extractedData, null, 2));

      if (context.extractedData.operacion === 'desconocido') {
        console.log('[COORDINADOR] Cancelado: Operación desconocida o no clasificada como pedido.');
        context.status = 'FAILED';
        context.errors.push('Operación no clasificada.');
        return context;
      }
      context.status = 'EXTRACTED';

      // 2. Agente 2: Geolocalizador e intenciones
      const hasUbicacion = context.extractedData.zonas && context.extractedData.zonas.length > 0;
      if (hasUbicacion) {
        console.log(`[COORDINADOR] Ubicación detectada. Ejecutando Agente 2 (Geolocalizador)...`);
        context.zoneIntent = await extractZoneIntent(body, context.extractedData.operacion);
        console.log(`[COORDINADOR - AGENTE 2] JSON generado:`, JSON.stringify(context.zoneIntent, null, 2));
        context.status = 'GEOLOCATED';
      } else {
        console.log(`[COORDINADOR] No se detectó ubicación. Saltando Agente 2.`);
      }

      // 3. Matcher
      console.log(`[COORDINADOR] Comparando con ${this.propertyCatalog.length} propiedades...`);
      context.matches = [];
      let matchesFoundCount = 0;

      for (const property of this.propertyCatalog) {
        const matchResult = checkMatch(context.extractedData, property, context.zoneIntent);

        if (matchResult.isMatch) {
          console.log(`[COORDINADOR] Match algorítmico encontrado para ${property.domicilio}. Ejecutando Agente Validador...`);
          const validation = await validateMatch(body, property, context.extractedData);
          console.log(`[COORDINADOR - VALIDADOR] Score: ${validation.score}%, isValid: ${validation.isValid}, Razonamiento: "${validation.reasoning}"`);

          const matchDetailsText = `Score Físico: ${matchResult.score}% | Score IA: ${validation.score}%\n\nMotivo Validación:\n${validation.reasoning}\n\nDetalles Algorítmicos:\n${matchResult.reasons.join('\n')}`;

          // Persistir el match en PostgreSQL (tanto si es válido como si no)
          if (dbMessage) {
            try {
              const dbProperty = await prisma.property.findFirst({
                where: {
                  domicilio: property.domicilio,
                  sheetName: property.sheetName,
                  pisoLote: property.pisoLote || null
                }
              });

              if (dbProperty) {
                await prisma.match.create({
                  data: {
                    messageId: dbMessage.id,
                    propertyId: dbProperty.id,
                    score: matchResult.score,
                    validationScore: validation.score,
                    isValid: validation.isValid,
                    reasoning: validation.reasoning,
                    matchDetails: matchDetailsText
                  }
                });
                console.log(`[COORDINADOR - DB] Match con propiedad ${property.domicilio} registrado en PostgreSQL.`);
              }
            } catch (dbErr) {
              console.warn('[COORDINADOR - DB] Error al registrar el match en PostgreSQL:', dbErr);
            }
          }

          if (validation.isValid && validation.score >= 70) {
            matchesFoundCount++;
            context.matches.push({ property, score: validation.score });
            
            console.log(`[COORDINADOR - MATCH APROBADO]:`);
            console.log(` - Propiedad: ${property.domicilio} (Precio: ${property.moneda} ${property.precio})`);
            console.log(` - Score de validación: ${validation.score}%`);
            console.log(` - Detalles:`, matchResult.reasons.join(', '));

            // Guardar coincidencia en Google Sheets
            await saveMatch(body, sender, property, matchDetailsText);

            // Registrar en memoria local del coordinador
            const matchFecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' });
            this.recentMatches.unshift({
              fecha: matchFecha,
              originalText: body,
              contactSender: sender,
              groupName: groupName,
              property,
              matchDetails: matchDetailsText
            });

            // Limitar caché de matches recientes
            if (this.recentMatches.length > 50) {
              this.recentMatches.pop();
            }
          } else {
            console.log(`[COORDINADOR - MATCH RECHAZADO/SILENCIADO] La propiedad ${property.domicilio} no superó la curación del Validador.`);
          }
        }
      }

      context.status = 'MATCHED';

      // 4. Notificaciones
      if (matchesFoundCount > 0) {
        const matchIntro = matchesFoundCount === 1 
          ? `🏠 *¡${matchesFoundCount} MATCH ENCONTRADO!*`
          : `🏠 *¡${matchesFoundCount} MATCHES ENCONTRADOS!*`;

        const propDetails = context.matches.map((m, idx) => {
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
        context.status = 'NOTIFIED';
      } else {
        console.log(`[COORDINADOR] No se encontraron coincidencias para este pedido.`);
      }

    } catch (error: any) {
      console.error('[COORDINADOR] Error en la ejecución del pipeline:', error);
      context.status = 'FAILED';
      context.errors.push(error.message || 'Error desconocido.');
    }

    console.log(`--------------------------------------------------\n`);
    return context;
  }
}

// Instancia única exportada para facilidad de uso
export const coordinator = new CoordinatorAgent();
