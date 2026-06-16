# SPEC-0005: Robustez e Idempotencia en la Base de Datos

## 1. Contexto y Justificación
Con la transición a un sistema multiusuario y pruebas de concurrencia concurrentes, se identificaron dos fallas potenciales en la persistencia del sistema en Supabase:
1. **Mensajes Duplicados**: WhatsApp puede reintentar el envío de un mismo mensaje debido a fluctuaciones en la conexión, resultando en ejecuciones redundantes de agentes de IA y registros duplicados.
2. **Vaciamiento Temporal del Catálogo**: El catálogo de propiedades se borraba por completo mediante `delete()` antes de insertar el nuevo lote de Google Sheets. Durante esta ventana, las solicitudes entrantes no encontraban ninguna coincidencia.

## 2. Requisitos de Diseño e Implementación

### 2.1. Idempotencia en la Recepción de Mensajes
* **ID Único**: Se aprovecha el identificador nativo y único provisto por WhatsApp en Baileys (`key.id`) como clave primaria (`id`) de la tabla `Message`.
* **Firma del Coordinador**: Se actualiza `handleIncomingMessage` en [coordinator.ts](file:///c:/Users/NoxiePC/Desktop/Software/housematch/src/services/coordinator.ts) para recibir el `messageId`.
* **Guardia de Existencia**: Antes de invocar a los agentes de Gemini, se realiza una consulta rápida:
  ```typescript
  const { data: existingMsg } = await supabase.from('Message').select('id').eq('id', messageId).maybeSingle();
  ```
  Si se encuentra el ID, se detiene el flujo temprano retornando el contexto sin volver a ejecutar los agentes ni matchear.

### 2.2. Sincronización Inteligente de Propiedades (Upsert en Aplicación)
* **Clave de Unicidad Comercial**: Se define la identidad de una propiedad inmobiliaria en la cartera mediante la clave compuesta:
  `domicilio + pisoLote + sheetName` (normalizada a minúsculas y sin espacios adicionales).
* **Flujo del Sync**:
  1. Descargar las propiedades registradas en base de datos.
  2. Clasificar el lote entrante en:
     * **Updates**: Si la clave ya existía, se preserva su `id` (UUID original) y se actualizan sus atributos.
     * **Inserts**: Si la clave es nueva, se le asigna un nuevo `id` con `randomUUID()`.
     * **Deletes**: Si el ID de base de datos no apareció en el lote de Google Sheets, se marca para eliminación.
  3. Ejecutar los cambios a través de `.upsert()` y `.delete().in()` de Supabase de manera atómica para evitar tiempos de inactividad de catálogo.

## 3. Impacto e Integración
* **whatsapp.ts**: Pasa el ID nativo del mensaje (`msg.key.id`) en el despacho del evento `onMessage`.
* **index.ts**: Adapta el listener para propagar dicho ID al coordinador de pipeline.
* **sheets.ts**: Define y ejecuta la lógica de comparación y llamadas por lote a Supabase.
