# Contexto del Proyecto: HouseMatch Core (Memoria Viva)

Este documento proporciona la única fuente de verdad sobre la arquitectura, componentes, flujo de datos y modelo de agentes de **HouseMatch Multi-Tenant**.

---

## 🧠 REGLA CRÍTICA DE MEMORIA AGÉNTICA (System Override)
1. **Lectura obligatoria:** Antes de ejecutar cualquier tarea, todo agente DEBE consultar este archivo (`.agent/CONTEXT.md`) para entender el estado tecnológico y reglas del proyecto.
2. **Actualización de Contexto:** Una vez que `@git` realice un push exitoso, o que `@pm` marque una tarea como completada, el agente activo TIENE la obligación de editar este archivo (`.agent/CONTEXT.md`).
3. **Qué actualizar:** Debes actualizar la sección "6. Estado del Arte y Tracking de Evolución", moviendo las tareas completadas y actualizando la arquitectura si aplica.
4. **Ahorro de Tokens:** Ningún agente debe leer los archivos históricos de la carpeta de evolución de forma simultánea. El estado consolidado vive aquí.

---

## 1. Propósito del Sistema
**HouseMatch** es una herramienta automatizada multi-tenant diseñada para capturar pedidos de propiedades en grupos de WhatsApp de agentes inmobiliarios (Tucumán, Argentina), extraer sus intenciones y características mediante modelos de lenguaje (LLM), y cruzarlos inteligentemente con una cartera local de propiedades en Supabase. Los matches calificados son notificados de forma consolidada por WhatsApp (cada 10 min) y se gestionan desde un Dashboard interactivo securizado por IP-Binding.

---

## 2. Esquema de Base de Datos Actualizado (Supabase Multi-Tenant)
Los agentes deben respetar de forma estricta la existencia de la clave foránea `tenant_id` en todas las operaciones de lectura/escritura:

* **`Tenant`**: `id` (UUID, PK), `phone_number` (JID del bot), `associated_ip`, `ip_bound_at`, `otp_code`, `otp_expires_at`. (Límite estricto de 10 tenants).
* **`Property`**: `id` (UUID, PK), `tenant_id` (FK, NOT NULL), `domicilio`, `pisoLote`, `precio`, `moneda`, `expensas`, `dormitorios`, `caracteristicas`, `contacto`, `zona`, `operacion`, `tipoPropiedad`, `sheetName`, `latitud`, `longitud`.
* **`Message`**: Clave primaria compuesta `(id, tenant_id)`. `body`, `sender`, `groupName`, `senderPhone`, `timestamp`.
* **`Match`**: `id` (UUID, PK), `tenant_id` (FK, NOT NULL), `messageId` (FK), `propertyId` (FK), `score`, `validationScore`, `isValid` (Boolean), `reasoning`, `matchDetails`, `userReviewStatus` ('PENDING' | 'ACCEPTED' | 'REJECTED'), `feedbackReason`, `notification_status` ('PENDING' | 'SENT'), `fecha`.

---

## 3. Arquitectura del Código y Estructura de Archivos

La aplicación está construida sobre **Node.js** utilizando **TypeScript** y el gestor de paquetes **pnpm**.

* `src/index.ts`: Punto de entrada del sistema. Inicializa el servidor Express, levanta las sesiones dinámicas de Baileys multi-tenant y despacha mensajes entrantes a la cola asíncrona.
* `src/services/coordinator.ts`: **Orquestador Principal**. Controla la idempotencia por ID nativo de WhatsApp, la deduplicación de 24 horas, la secuencia de ejecución de los sub-agentes y persiste los resultados iniciales en Supabase con estado `notification_status = 'PENDING'`.
* `src/services/ai.ts`: Implementa el patrón **Strategy** para proveedores de IA.
    * *Google Gemini Strategy (`gemini-2.5-flash-lite`)*: Modelo principal por costo y velocidad.
    * *OpenAI Strategy (`gpt-4o-mini`)*: Fallback dinámico automático configurado obligatoriamente con **Structured Outputs** (`json_schema`).
    * *Sub-Agentes Cognitivos:* **Agente 1 (Extractor)** con blindaje XML wrappers, **Agente 2 (Geolocalizador)** normalizador de zonas de Tucumán, y **Agente 3 (Validador)** filtro cualitativo de falsos positivos.
* `src/services/notifier.ts`: Hilo asíncrono en background que corre cada 10 minutos. Consolida los matches `PENDING` por tenant, aplica delay de escritura humana (2-4s) y rota entre 5 plantillas estilísticas distintas para evitar baneo.
* `src/utils/matcher.ts`: Motor de coincidencia refactorizado bajo el patrón **Strategy**. Ejecuta 7 estrategias secuenciales (`Operation`, `PropertyType`, `Country`, `Zone`, `Bedrooms`, `Budget`, `Features`) con cortocircuito rápido ante descartes críticos.
* `cache/`: Directorio reservado e ignorado en Git para almacenar archivos JSON de sesión, configuraciones temporales de grupos y logs locales de ejecución.

---

## 4. Robustez y Seguridad
1.  **Idempotencia:** Control estricto en `coordinator.ts` mediante el ID único nativo de WhatsApp para evitar reprocesamiento y doble gasto de tokens.
2.  **Sincronización Atómica:** El proceso de carga de propiedades desde Excel/Sheets realiza un algoritmo de diferenciación (Updates/Inserts/Deletes) mediante `.upsert()` en Supabase para evitar ventanas de catálogo vacío.
3.  **Prompt Injection Shield:** Toda entrada de chat de usuario se inyecta a las APIs de IA envuelta en etiquetas XML estricta junto a instrucciones de inmunidad operativa del sistema.

---

## 5. Estado del Arte y Tracking de Evolución
*(Esta sección es mantenida activamente por @pm, @product y @git)*

### Última Especificación Implementada
* **SPEC-0011:** Arquitectura de propiedades centrada en base de datos (eliminación de Sheets y caché local en disco).
* **SPEC-0010:** Mitigación de deuda técnica (colas de mensajes por tenant), fugas de memoria (Supabase, WhatsApp huerfan timeouts) y cotización dinámica del Dólar Blue (DolarAPI).
* **SPEC-0009:** Refactorización de calidad, implementación del patrón Strategy en el Matcher, Structured Outputs en OpenAI y ordenamiento de directorios (`cache/`).

### Deuda Técnica y Próximos Pasos Activos
- [ ] Implementar la suite de pruebas unitarias automatizadas para las 7 nuevas clases de estrategia de `src/utils/matcher.ts` (Asignado a: `@qa`).
- [ ] Conectar los nuevos endpoints de visualización multi-tenant en el Frontend asegurando que se filtre correctamente por el IP-Binding de 12 horas (Asignado a: `@frontend`).
- [ ] Optimizar la estrategia de fallback en `src/services/ai.ts` para que reporte métricas de reintento en el log de Supabase.