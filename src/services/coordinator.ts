import { extractRealEstateRequest, extractZoneIntent, ExtractedRealEstateRequest, ZoneIntentRequest, validateMatch } from './ai';
import { Property } from './sheets';
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


    // 1. Verificar idempotencia por (ID de mensaje, tenantId)
    if (messageId) {
      try {
        const { data: existingMsg, error: checkErr } = await supabase
          .from('Message')
          .select('id')
          .eq('id', messageId)
          .eq('tenant_id', tenantId)
          .maybeSingle();

        if (checkErr) throw checkErr;

        if (existingMsg) {
          logger.info({ messageId, tenantId }, '[COORDINADOR] Mensaje ya procesado para este Tenant (idempotencia). Omitiendo.');
          context.status = 'MATCHED';
          return context;
        }
      } catch (checkErr: any) {
        logger.warn({ error: checkErr.message || checkErr, messageId, tenantId }, '[COORDINADOR] Error al comprobar idempotencia por ID y Tenant');
      }
    }

    try {
      // 2. Deduplicación temporal por tenantId: mismo remitente y contenido en las últimas 24 horas
      const aDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: duplicateMsg, error: checkDupErr } = await supabase
        .from('Message')
        .select('id')
        .eq('body', body)
        .eq('senderPhone', senderPhone)
        .eq('tenant_id', tenantId)
        .gt('timestamp', aDayAgo)
        .limit(1)
        .maybeSingle();

      if (checkDupErr) throw checkDupErr;

      if (duplicateMsg) {
        logger.info({ messageId, tenantId, duplicateOf: duplicateMsg.id }, '[COORDINADOR] Mensaje idéntico procesado en últimas 24hs para este Tenant. Omitiendo.');
        context.status = 'MATCHED';
        return context;
      }
    } catch (checkDupErr: any) {
      logger.warn({ error: checkDupErr.message || checkDupErr, messageId, tenantId }, '[COORDINADOR] Error al comprobar deduplicación temporal');
    }

    // Registrar mensaje en la base de datos
    let dbMessage: any = null;
    try {
      const { data, error } = await supabase
        .from('Message')
        .insert({
          id: messageId || randomUUID(),
          body,
          sender,
          groupName,
          senderPhone,
          tenant_id: tenantId
        })
        .select()
        .single();
        
      if (error) throw error;
      dbMessage = data;
    } catch (e: any) {
      logger.warn({ error: e.message || e, tenantId }, '[COORDINADOR - SUPABASE] No se pudo guardar el mensaje entrante');
    }

    try {
      // 3. Agente 1: Extractor de Entidades
      logger.info({ tenantId }, '[COORDINADOR] Ejecutando Agente 1 (Extractor)...');
      context.extractedData = await extractRealEstateRequest(body);
      logger.info({ extractedData: context.extractedData, tenantId }, '[COORDINADOR - AGENTE 1] Extracción completada');

      if (context.extractedData.operacion === 'desconocido') {
        logger.info({ tenantId }, '[COORDINADOR] Cancelado: Operación no clasificada como pedido.');
        context.status = 'FAILED';
        context.errors.push('Operación no clasificada.');
        return context;
      }
      context.status = 'EXTRACTED';

      // 4. Agente 2: Geolocalizador e intenciones
      const hasUbicacion = context.extractedData.zonas && context.extractedData.zonas.length > 0;
      if (hasUbicacion) {
        logger.info({ tenantId }, '[COORDINADOR] Ubicación detectada. Ejecutando Agente 2 (Geolocalizador)...');
        context.zoneIntent = await extractZoneIntent(body, context.extractedData.operacion);
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
          logger.info({ property: property.domicilio, tenantId }, '[COORDINADOR] Match algorítmico encontrado. Ejecutando Agente Validador...');
          const validation = await validateMatch(body, property, context.extractedData);
          logger.info({ 
            property: property.domicilio, 
            score: validation.score, 
            isValid: validation.isValid,
            tenantId
          }, '[COORDINADOR - VALIDADOR] Evaluación finalizada');

          const matchDetailsText = `Score Físico: ${matchResult.score}% | Score IA: ${validation.score}%\n\nMotivo Validación:\n${validation.reasoning}\n\nDetalles Algorítmicos:\n${matchResult.reasons.join('\n')}`;

          // Persistir el match en Supabase
          if (dbMessage) {
            try {
              // Obtener ID de la propiedad correspondiente al tenant
              const { data: dbProperty, error: propErr } = await supabase
                .from('Property')
                .select('id')
                .eq('domicilio', property.domicilio)
                .eq('sheetName', property.sheetName)
                .eq('pisoLote', property.pisoLote || null)
                .eq('tenant_id', tenantId)
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
                    matchDetails: matchDetailsText,
                    tenant_id: tenantId,
                    notification_status: 'PENDING' // Se guarda como PENDING para el Notificador consolidado
                  });
                if (matchErr) throw matchErr;
                logger.info({ property: property.domicilio, tenantId }, '[COORDINADOR - SUPABASE] Match registrado con estado PENDING');
              }
            } catch (dbErr: any) {
              logger.warn({ error: dbErr.message || dbErr, tenantId }, '[COORDINADOR - SUPABASE] Error al registrar el match');
            }
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
