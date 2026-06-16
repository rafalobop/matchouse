# SPEC-0006: Sistema de Colas (Rate Limiter) y Base de Datos como Fuente de la Verdad

## 1. Contexto y Justificación
Para garantizar la estabilidad del sistema frente a picos de tráfico en grupos de WhatsApp y evitar bloqueos por cuota en el plan gratuito de Google Gemini (límite de 15 solicitudes por minuto), se decidió implementar un sistema de encolamiento asíncrono. 
Además, para simplificar la infraestructura y evitar escrituras lentas y redundantes, se desvinculó Google Sheets del almacenamiento de los matches, definiendo a Supabase PostgreSQL como la única fuente de la verdad para el estado de las propiedades y el registro histórico de coincidencias.

## 2. Requisitos de Diseño e Implementación

### 2.1. Rate Limiting y Cola Asíncrona (`AsyncMessageQueue`)
* **Cola de Concurrencia Limitada**: Se diseñó una cola en memoria en [queue.ts](file:///c:/Users/NoxiePC/Desktop/Software/housematch/src/utils/queue.ts) que procesa los mensajes de forma estrictamente secuencial.
* **Intervalo de Seguridad**: Tras finalizar el procesamiento de cada mensaje por el Agente Coordinador, la cola introduce un delay de **4.5 segundos** antes de consumir el siguiente elemento, garantizando un máximo seguro de 13 peticiones por minuto para mantenerse dentro de los límites de Gemini.
* **Resiliencia**: Los errores surgidos durante la ejecución de una tarea son capturados y registrados por el logger, evitando que bloqueen o detengan el procesamiento de los demás elementos de la cola.

### 2.2. Base de Datos como Fuente de la Verdad
* **Remoción de Google Sheets para Matches**: Se eliminaron las importaciones y llamadas a `saveMatch` en [coordinator.ts](file:///c:/Users/NoxiePC/Desktop/Software/housematch/src/services/coordinator.ts). Google Sheets se conserva únicamente como entrada de datos de lectura para actualizar la cartera de propiedades.
* **Carga de Catálogo Directa**: Al arrancar la aplicación, el catálogo de propiedades en memoria se carga directamente de Supabase, recurriendo al archivo en disco local solo como un respaldo si la base de datos se encuentra completamente vacía.

## 3. Estructura y Componentes Afectados
* **`src/utils/queue.ts`** [NEW]: Implementación del despachador y la cola asíncrona de procesamiento.
* **`src/services/coordinator.ts`** [MODIFY]: Remoción de las dependencias e integraciones de guardado de matches en Google Sheets API.
* **`src/index.ts`** [MODIFY]: Integración del listener de eventos de WhatsApp con el despachador de la cola asíncrona.
