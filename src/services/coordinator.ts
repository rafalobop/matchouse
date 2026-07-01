import { extractRealEstateRequest, extractZoneIntent, ExtractedRealEstateRequest, ZoneIntentRequest, validateMatch } from './ai';
import { Property } from './excel';
import { checkMatch } from '../utils/matcher';
import { randomUUID } from 'crypto';
import { logger } from './logger';
import { supabase } from './supabase';

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
  status: 'PENDING' | 'EXTRACTED' | 'GEOLOCATED' | 'MATCHED' | 'FAILED';
  errors: string[];
}

export class CoordinatorAgent {
  // Cachés en memoria indexadas por tenant_id
  private recentMatches = new Map<string, any[]>();
  private propertyCatalogs = new Map<string, Property[]>();

  constructor() {}

  /**
   * Actualiza el catálogo local en memoria utilizado para la comparación de un tenant
   */
  setCatalog(tenantId: string, catalog: Property[]) {
    this.propertyCatalogs.set(tenantId, catalog);
  }

  /**
   * Obtiene el catálogo en memoria de un tenant
   */
  getCatalog(tenantId: string): Property[] {
    return this.propertyCatalogs.get(tenantId) || [];
  }

  /**
   * Obtiene los últimos matches registrados en memoria para un tenant
   */
  getRecentMatches(tenantId: string): any[] {
    return this.recentMatches.get(tenantId) || [];
  }

  /**
   * Orquesta la ejecución de los sub-agentes de forma aislada por Tenant
   */
  async handleIncomingMessage(
    body: string, 
    sender: string, 
    groupName: string, 
    senderPhone: string,
    messageId: string | undefined,
    tenantId: string
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

    logger.info({ sender, groupName, bodySnippet: body.substring(0, 100), messageId, tenantId }, '[COORDINADOR] Iniciando orquestación de pedido multi-tenant');


    try {
      // 1. Deduplicación: mismo remitente + mismo texto en las últimas 24 horas
      const aDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: duplicateMatch, error: checkDupErr } = await supabase
        .from('match_queue')
        .select('id')
        .eq('raw_message_text', body)
        .eq('whatsapp_sender_phone', senderPhone)
        .eq('tenant_id', tenantId)
        .gte('created_at', aDayAgo)
        .limit(1)
        .maybeSingle();

      if (checkDupErr) throw checkDupErr;

      if (duplicateMatch) {
        logger.info({ tenantId, duplicateOf: duplicateMatch.id }, '[COORDINADOR] Mensaje idéntico procesado en últimas 24hs para este Tenant. Omitiendo.');
        context.status = 'MATCHED';
        return context;
      }
    } catch (checkDupErr: any) {
      logger.warn({ error: checkDupErr.message || checkDupErr, tenantId }, '[COORDINADOR] Error al comprobar deduplicación temporal');
    }

    try {
      // 3. Agente 1: Extractor de Entidades
      logger.info({ tenantId }, '[COORDINADOR] Ejecutando Agente 1 (Extractor)...');
      context.extractedData = await extractRealEstateRequest(body);
      logger.info({ extractedData: context.extractedData, tenantId }, '[COORDINADOR - AGENTE 1] Extracción completada');

      if (context.extractedData.operation === 'desconocido') {
        logger.info({ tenantId }, '[COORDINADOR] Cancelado: Operación no clasificada como pedido.');
        context.status = 'FAILED';
        context.errors.push('Operación no clasificada.');
        return context;
      }
      context.status = 'EXTRACTED';

      // 4. Agente 2: Geolocalizador e intenciones
      const hasUbicacion = context.extractedData.zones && context.extractedData.zones.length > 0;
      if (hasUbicacion) {
        logger.info({ tenantId }, '[COORDINADOR] Ubicación detectada. Ejecutando Agente 2 (Geolocalizador)...');
        context.zoneIntent = await extractZoneIntent(body, context.extractedData.operation);
        logger.info({ zoneIntent: context.zoneIntent, tenantId }, '[COORDINADOR - AGENTE 2] Geolocalización completada');
        context.status = 'GEOLOCATED';
      } else {
        logger.info({ tenantId }, '[COORDINADOR] No se detectó ubicación. Saltando Agente 2.');
      }

      // 5. Comparación (Matcher) con la cartera del Tenant
      const tenantCatalog = this.getCatalog(tenantId);
      logger.info({ catalogLength: tenantCatalog.length, tenantId }, '[COORDINADOR] Comparando con cartera del tenant...');
      context.matches = [];
      let matchesFoundCount = 0;

      for (const property of tenantCatalog) {
        const matchResult = checkMatch(context.extractedData, property, context.zoneIntent);

        if (matchResult.isMatch) {
          logger.info({ property: property.address, tenantId }, '[COORDINADOR] Match algorítmico encontrado. Ejecutando Agente Validador...');
          const validation = await validateMatch(body, property, context.extractedData);
          logger.info({
            property: property.address,
            score: validation.score,
            isValid: validation.isValid,
            tenantId
          }, '[COORDINADOR - VALIDADOR] Evaluación finalizada');

          const matchDetailsText = `Score Físico: ${matchResult.score}% | Score IA: ${validation.score}%\n\nMotivo Validación:\n${validation.reasoning}\n\nDetalles Algorítmicos:\n${matchResult.reasons.join('\n')}`;

          // Persistir el match en Supabase
          try {
            // Obtener ID de la propiedad correspondiente al tenant
            const { data: dbProperty, error: propErr } = await supabase
              .from('properties')
              .select('id')
              .eq('address', property.address)
              .eq('sheet_name', property.sheet_name)
              .eq('unit', property.unit || null)
              .eq('tenant_id', tenantId)
              .limit(1)
              .maybeSingle();

            if (propErr) throw propErr;

            if (dbProperty) {
              const { error: matchErr } = await supabase
                .from('match_queue')
                .insert({
                  id: randomUUID(),
                  tenant_id: tenantId,
                  property_id: dbProperty.id,
                  whatsapp_group_name: groupName,
                  whatsapp_sender_name: sender,
                  whatsapp_sender_phone: senderPhone,
                  raw_message_text: body,
                  is_notified: false,
                  score: matchResult.score,
                  validation_score: validation.score,
                  is_valid: validation.isValid,
                  reasoning: validation.reasoning,
                  match_details: matchDetailsText
                });
              if (matchErr) throw matchErr;
              logger.info({ property: property.address, tenantId }, '[COORDINADOR - SUPABASE] Match registrado en match_queue');
            }
          } catch (dbErr: any) {
            logger.warn({ error: dbErr.message || dbErr, tenantId }, '[COORDINADOR - SUPABASE] Error al registrar el match');
          }

          // Si califica, registrarlo en la memoria caché del tenant
          if (validation.isValid && validation.score >= 70) {
            matchesFoundCount++;
            context.matches.push({ property, score: validation.score });

            // Registrar en memoria local del tenant
            const matchFecha = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' });
            const tenantRecent = this.recentMatches.get(tenantId) || [];
            tenantRecent.unshift({
              fecha: matchFecha,
              originalText: body,
              contactSender: sender,
              groupName: groupName,
              property,
              matchDetails: matchDetailsText
            });

            // Limitar a 50 matches en caché de memoria
            if (tenantRecent.length > 50) {
              tenantRecent.pop();
            }
            this.recentMatches.set(tenantId, tenantRecent);
          }
        }
      }

      context.status = 'MATCHED';

    } catch (error: any) {
      logger.error({ error: error.message || error, tenantId }, '[COORDINADOR] Error en la ejecución del pipeline');
      context.status = 'FAILED';
      context.errors.push(error.message || 'Error desconocido.');
    }

    return context;
  }
}

export const coordinator = new CoordinatorAgent();
