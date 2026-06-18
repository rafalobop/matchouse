# SPEC-0002: Definición y Rol del Agente Coordinador (Orquestador)

## 1. De Pipeline Lineal a Orquestación Multi-Agente
En el MVP actual, la lógica de procesamiento está acoplada directamente en la función `processIncomingMessage` de `src/index.ts`. Este diseño dificulta:
*   Agregar nuevos agentes especializados (ej. Agente Validador, Agente de Scoring, o Agente de Redacción de Mensajes).
*   Seguir la trazabilidad/logs detallados de qué decidió cada agente y por qué.
*   Implementar un sistema de reintentos, fallback avanzado o feedback continuo.

El **Agente Coordinador** actúa como el director de orquesta. Es responsable del ciclo de vida completo de la evolución de un pedido, gestionando la comunicación entre sub-agentes, controlando el flujo y persistiendo el estado.

```
       [ Mensaje Entrante ]
                │
                ▼
   ┌──────────────────────────┐
   │    Agente Coordinador    │◄─── Conexión/Events (WhatsApp)
   └────────────┬─────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
   ┌──────────┐   ┌──────────┐
   │ Agente 1 │   │ Agente 2 │   ... [Futuros Agentes]
   │Extractor │   │Geolocator│
   └──────────┘   └──────────┘
```

## 2. Responsabilidades del Agente Coordinador
1.  **Orquestación Dinámica de Tareas**: Decidir qué agentes se deben ejecutar según el estado actual del procesamiento (ej. si el Extractor no encuentra ubicación, omitir el Geolocalizador).
2.  **Manejo de Contexto y Memoria**: Mantener un objeto de contexto de ejecución (`PipelineContext`) que almacene los resultados temporales de cada agente.
3.  **Tolerancia a Fallos y Registro**: Capturar logs detallados de la ejecución de cada agente y decidir si se ejecuta una estrategia de fallback.
4.  **Desacoplamiento**: Separar la lógica de negocio (IA, Matcher) de los adaptadores de entrada/salida (WhatsApp, HTTP Express).

### Firewall de Entrada y Pre-filtrado Estático
Para evitar el consumo innecesario de recursos, llamadas a APIs y generación de registros de logs en mensajes casuales (no comerciales):
*   El listener de WhatsApp en `whatsapp.ts` (evento `messages.upsert`) **seguirá actuando como firewall de entrada**.
*   Se mantendrá el filtro estático local `isRealEstateRequest(body)` y el filtro de grupos seleccionados en la capa del receptor de WhatsApp antes de llamar al Coordinador.
*   Esto asegura que el Coordinador solo sea invocado cuando el mensaje sea legítimamente calificado como un posible pedido de propiedad.


## 3. Propuesta de Interfaz Técnica

Proponemos la creación de un servicio unificado en `src/services/coordinator.ts`:

```typescript
export interface PipelineContext {
  messageId: string;
  body: string;
  sender: string;
  groupName: string;
  senderPhone: string;
  timestamp: Date;
  
  // Resultados acumulativos de sub-agentes
  extractedData?: ExtractedRealEstateRequest;
  zoneIntent?: ZoneIntentRequest;
  matches?: Array<{ property: Property; score: number }>;
  
  // Estado de la ejecución
  status: 'PENDING' | 'EXTRACTED' | 'GEOLOCATED' | 'MATCHED' | 'NOTIFIED' | 'FAILED';
  errors: string[];
}

export class CoordinatorAgent {
  // Orquesta la ejecución secuencial o condicional de los sub-agentes
  async handleIncomingMessage(
    body: string, 
    sender: string, 
    groupName: string, 
    senderPhone: string
  ): Promise<PipelineContext>;
}
```

## 4. Beneficios Inmediatos
*   **Modularidad**: Los agentes residen en archivos limpios y solo se comunican a través del contexto provisto por el Coordinador.
*   **Preparación para la Persistencia (SQL)**: Guardar el `PipelineContext` en una base de datos relacional resolverá la limitación del MVP de no tener un histórico de trazabilidad robusto.
*   **Fácil Testeabilidad**: Permite simular el pipeline completo pasando un `PipelineContext` mockeado en tests unitarios/de integración.
