import { extractRealEstateRequest, extractZoneIntent, ExtractedRealEstateRequest, ZoneIntentRequest, validateMatch } from './gemini';
import { Property, saveMatch } from './sheets';
import { checkMatch } from '../utils/matcher';
import { sendWhatsAppNotification } from './whatsapp';
import { randomUUID } from 'crypto';
import { logger } from './logger';

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
    senderPhone: string,
    messageId?: string
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

    logger.info({ sender, groupName, bodySnippet: body.substring(0, 100), messageId }, '[COORDINADOR] Iniciando orquestación de pedido');

    const { supabase } = require('./supabase');

    if (messageId) {
      try {
        const { data: existingMsg, error: checkErr } = await supabase
          .from('Message')
          .select('id')
          .eq('id', messageId)
          .maybeSingle();

        if (checkErr) throw checkErr;

        if (existingMsg) {
          logger.info({ messageId }, '[COORDINADOR] Mensaje ya procesado (idempotencia). Omitiendo pipeline.');
          context.status = 'MATCHED';
          return context;
        }
      } catch (checkErr: any) {
        logger.warn({ error: checkErr.message || checkErr, messageId }, '[COORDINADOR] Error al comprobar idempotencia del mensaje');
      }
    }

    let dbMessage: any = null;
    try {
      const { data, error } = await supabase
        .from('Message')
        .insert({
          id: messageId || randomUUID(),
          body,
          sender,
          groupName,
          senderPhone
        })
        .select()
        .single();
        
      if (error) throw error;
      dbMessage = data;
    } catch (e: any) {
      logger.warn({ error: e.message || e }, '[COORDINADOR - SUPABASE] No se pudo guardar el mensaje entrante');
    }

    try {
      // 1. Agente 1: Extractor de Entidades
      logger.info('[COORDINADOR] Ejecutando Agente 1 (Extractor)...');
      context.extractedData = await extractRealEstateRequest(body);
      logger.info({ extractedData: context.extractedData }, '[COORDINADOR - AGENTE 1] Extracción completada');

      if (context.extractedData.operacion === 'desconocido') {
        logger.info('[COORDINADOR] Cancelado: Operación desconocida o no clasificada como pedido.');
        context.status = 'FAILED';
        context.errors.push('Operación no clasificada.');
        return context;
      }
      context.status = 'EXTRACTED';

      // 2. Agente 2: Geolocalizador e intenciones
      const hasUbicacion = context.extractedData.zonas && context.extractedData.zonas.length > 0;
      if (hasUbicacion) {
        logger.info('[COORDINADOR] Ubicación detectada. Ejecutando Agente 2 (Geolocalizador)...');
        context.zoneIntent = await extractZoneIntent(body, context.extractedData.operacion);
        logger.info({ zoneIntent: context.zoneIntent }, '[COORDINADOR - AGENTE 2] Geolocalización completada');
        context.status = 'GEOLOCATED';
      } else {
        logger.info('[COORDINADOR] No se detectó ubicación. Saltando Agente 2.');
      }

      // 3. Matcher
      logger.info({ catalogLength: this.propertyCatalog.length }, '[COORDINADOR] Comparando con propiedades del catálogo...');
      context.matches = [];
      let matchesFoundCount = 0;

      for (const property of this.propertyCatalog) {
        const matchResult = checkMatch(context.extractedData, property, context.zoneIntent);

        if (matchResult.isMatch) {
          logger.info({ property: property.domicilio }, '[COORDINADOR] Match algorítmico encontrado. Ejecutando Agente Validador...');
          const validation = await validateMatch(body, property, context.extractedData);
          logger.info({ 
            property: property.domicilio, 
            score: validation.score, 
            isValid: validation.isValid,
            reasoning: validation.reasoning
          }, '[COORDINADOR - VALIDADOR] Evaluación finalizada');

          const matchDetailsText = `Score Físico: ${matchResult.score}% | Score IA: ${validation.score}%\n\nMotivo Validación:\n${validation.reasoning}\n\nDetalles Algorítmicos:\n${matchResult.reasons.join('\n')}`;

          // Persistir el match en Supabase (tanto si es válido como si no)
          if (dbMessage) {
            try {
              const { data: dbProperty, error: propErr } = await supabase
                .from('Property')
                .select('id')
                .eq('domicilio', property.domicilio)
                .eq('sheetName', property.sheetName)
                .eq('pisoLote', property.pisoLote || null)
                .limit(1)
                .maybeSingle();

              if (propErr) throw propErr;

              if (dbProperty) {
                const { error: matchErr } = await supabase
                  .from('Match')
                  .insert({
                    id: randomUUID(),
                    messageId: dbMessage.id,
                    propertyId: dbProperty.id,
                    score: matchResult.score,
                    validationScore: validation.score,
                    isValid: validation.isValid,
                    reasoning: validation.reasoning,
                    matchDetails: matchDetailsText
                  });
                if (matchErr) throw matchErr;
                logger.info({ property: property.domicilio }, '[COORDINADOR - SUPABASE] Match registrado con éxito');
              }
            } catch (dbErr: any) {
              logger.warn({ error: dbErr.message || dbErr }, '[COORDINADOR - SUPABASE] Error al registrar el match');
            }
          }

          if (validation.isValid && validation.score >= 70) {
            matchesFoundCount++;
            context.matches.push({ property, score: validation.score });
            
            logger.info({ 
              property: property.domicilio, 
              precio: `${property.moneda} ${property.precio}`, 
              score: validation.score 
            }, '[COORDINADOR - MATCH APROBADO]');

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
            logger.info({ property: property.domicilio }, '[COORDINADOR - MATCH RECHAZADO/SILENCIADO] La propiedad no superó la curación del Validador.');
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
        logger.info('[COORDINADOR] No se encontraron coincidencias para este pedido.');
      }

    } catch (error: any) {
      logger.error({ error: error.message || error }, '[COORDINADOR] Error en la ejecución del pipeline');
      context.status = 'FAILED';
      context.errors.push(error.message || 'Error desconocido.');
    }

    return context;
  }
}

// Instancia única exportada para facilidad de uso
export const coordinator = new CoordinatorAgent();
