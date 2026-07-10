# Especificación 0012: Refactor de Esquema v2 — Migración a Schema en Inglés con Soporte PostGIS

Este documento detalla la especificación técnica e implementación del refactor de esquema de base de datos v2, que migra todas las tablas y campos de español a inglés, introduce soporte espacial PostGIS en Supabase y consolida el modelo de mensajes dentro de la cola de matches.

---

## 1. Contexto y Objetivos

El esquema original de Supabase fue diseñado con nombres de tablas y columnas en español, acoplado a los nombres internos del MVP. A medida que el proyecto evoluciona hacia internacionalización y soporte espacial, esta convención generaba fricciones:

- **Inconsistencia semántica:** Mezcla de inglés (código TypeScript) y español (BD) dificultaba la trazabilidad entre capas.
- **Sin soporte espacial:** Las columnas `latitud`/`longitud` eran simples numerics, sin tipado geográfico ni índices espaciales para consultas de proximidad.
- **Tabla `Message` separada:** Mantener una tabla de mensajes independiente añadía complejidad de joins innecesaria para el flujo de matching.
- **Auth key-value:** El patrón de credenciales multi-row en `WhatsappSession` era frágil y verboso.

El cambio fue aplicado directamente en Supabase (staging/prod) sobre instancias sin datos de tenants reales — corte limpio sin migraciones de datos legacy.

---

## 2. Decisiones de Diseño Técnico

### A. Renombrado de Tablas

| Tabla anterior    | Tabla nueva         |
|-------------------|---------------------|
| `Property`        | `properties`        |
| `Match`           | `match_queue`       |
| `Tenant`          | `profiles`          |
| `WhatsappSession` | `whatsapp_sessions` |

Las convenciones de nomenclatura siguen el estándar PostgREST/Supabase (snake_case, plural para tablas de dominio).

### B. Renombrado de Campos en `properties`

| Campo anterior  | Campo nuevo            | Notas                                    |
|-----------------|------------------------|------------------------------------------|
| `domicilio`     | `address`              |                                          |
| `pisoLote`      | `floor` / `unit` / `block` / `lot` | Descompuesto en campos atómicos     |
| `precio`        | `price`                |                                          |
| `moneda`        | `currency`             |                                          |
| `expensas`      | `maintenance_fees`     |                                          |
| `dormitorios`   | `bedrooms`             |                                          |
| `caracteristicas` | `features`           |                                          |
| `contacto`      | `contact_info`         |                                          |
| `zona`          | `zone_display_name`    | Campo runtime-only, no persistido en BD  |
| `operacion`     | `operation`            |                                          |
| `tipoPropiedad` | `property_type`        |                                          |
| `sheetName`     | `sheet_name`           |                                          |
| `latitud`       | `latitude`             | Preparado para columna PostGIS           |
| `longitud`      | `longitude`            | Preparado para columna PostGIS           |

### C. Consolidación de Mensajes en `match_queue`

Se eliminó la tabla `Message` separada. La cola de matches embebe directamente los datos del mensaje entrante como columnas planas:

- `whatsapp_group_name`
- `whatsapp_sender_name`
- `whatsapp_sender_phone`
- `raw_message_text`

Esto elimina los joins necesarios para reconstruir el contexto del match y simplifica el modelo de lectura del Dashboard.

### D. Reescritura de `supabaseAuth.ts` — Patrón JSONB Single-Row

El módulo `src/services/supabaseAuth.ts` fue reescrito para abandonar el patrón multi-row key-value en `whatsapp_sessions`. Ahora utiliza una única fila con columna JSONB (`auth_creds`) por sesión de tenant. Esto reduce la cantidad de filas leídas/escritas y permite actualizaciones atómicas del estado de credenciales.

### E. Endpoints de Auth Temporalmente Stubbed

Los endpoints `GET /api/auth/*` y `POST /api/auth/*` fueron marcados con respuesta `503 Service Unavailable` mientras se diseña la nueva capa de autenticación basada en Supabase Auth magic link. Esto evita dejar endpoints de auth funcionando con el esquema viejo durante la transición.

### F. `zone_display_name` como Campo Runtime-Only

La resolución espacial real (polígonos PostGIS, lookup de zona por coordenadas) fue diferida como spike separado. El campo `zone_display_name` existe únicamente en el tipo TypeScript `Property` para enriquecer la presentación en el Agente Geolocalizador, pero **no se persiste en base de datos**.

### G. Punto de Extensión Espacial en `matcher.ts`

Se exporta la función `resolvePropertyZoneId()` desde `src/utils/matcher.ts` como hook explícito para la futura integración de matching espacial PostGIS. Durante esta fase, la función es un stub que devuelve `null`.

---

## 3. Impacto en Componentes

* **`src/services/supabaseAuth.ts`** [REWRITE]: Migración a patrón single-row JSONB (`auth_creds`).
* **`src/utils/matcher.ts`** [MODIFY]: Adaptación a nuevos nombres de campos, exportación de `resolvePropertyZoneId()`.
* **`src/services/excel.ts`** [MODIFY]: Actualización del tipo `Property` y queries de BD al nuevo esquema.
* **`src/services/coordinator.ts`** [MODIFY]: Ajuste de inserts/reads a `match_queue` con campos de mensaje embebidos.
* **`src/services/ai.ts`** [MODIFY]: Renombrado de campos en `ExtractedRealEstateRequest` a inglés.
* **API routes `/api/auth/*`** [STUB]: Respuestas 503 hasta reimplementación con magic link.

---

## 4. Estado de Implementación

- **Status:** Completado
- **Tests:** 15/15 en verde
- **Fecha de cierre:** 2026-07-01

---

## 5. Pendientes para Siguiente Sesión

- [ ] **Auth Supabase magic link:** Reimplementar los endpoints `/api/auth/*` usando Supabase Auth con flujo de email magic link (reemplaza el binding por OTP de WhatsApp).
- [ ] **Notificación por email:** Reemplazar el canal de notificación de matches de WhatsApp a email (desacoplamiento del bot para notificaciones).
- [ ] **Matching espacial PostGIS:** Implementar polígonos de zonas en Supabase e integrar la búsqueda espacial real en `resolvePropertyZoneId()`.
- [ ] **LangGraph:** Evaluar migración del flujo de agentes cognitivos a LangGraph para control de estado y reintentos más sofisticados.
