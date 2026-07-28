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

## 2. Esquema de Base de Datos Actualizado (Supabase Multi-Tenant) — v2

Los agentes deben respetar de forma estricta la existencia de la clave foránea `tenant_id` en todas las operaciones de lectura/escritura. El esquema fue migrado a inglés en SPEC-0012 con soporte PostGIS. La tabla `Message` fue eliminada — sus datos se embeben en `match_queue`.

* **`profiles`** *(ex `Tenant`)*: `id` (UUID, PK), `phone_number` (JID del bot), `associated_ip`, `ip_bound_at`, `otp_code`, `otp_expires_at`. (Límite estricto de 10 tenants).
* **`properties`** *(ex `Property`)*: `id` (UUID, PK), `tenant_id` (FK, NOT NULL), `address`, `floor`, `unit`, `block`, `lot`, `price`, `currency`, `maintenance_fees`, `bedrooms`, `features`, `contact_info`, `operation`, `property_type`, `sheet_name`, `latitude`, `longitude`. **Nota:** `zone_display_name` es campo runtime-only en TypeScript — NO se persiste en BD.
* **`match_queue`** *(ex `Match`, absorbe ex `Message`)*: `id` (UUID, PK), `tenant_id` (FK, NOT NULL), `property_id` (FK, NOT NULL), `is_notified` (Boolean, NOT NULL, default `false`), `created_at` (timestamptz), `score`, `validation_score`, `is_valid` (Boolean), `reasoning`, `match_details`, `user_review_status` ('PENDING' | 'ACCEPTED' | 'REJECTED'), `feedback_reason`. Campos de mensaje embebidos: `whatsapp_group_name`, `whatsapp_sender_name`, `whatsapp_sender_phone`, `raw_message_text`. **Corrección (2026-07-02):** columnas reales confirmadas por introspección directa vía MCP de Supabase — no existen `notification_status` ni `fecha` (drift de esta misma documentación, nunca existieron en la base; el código siempre usó `is_notified`/`created_at`). DDL completo en `docs/evolucion_proyecto/schema_actual.sql`.
* **`whatsapp_sessions`** *(ex `WhatsappSession`)*: Single-row por tenant con columna JSONB `auth_creds` (patrón reescrito en SPEC-0012; reemplaza el esquema multi-row key-value anterior).

**Auth:** Implementada con Supabase Auth magic link (SPEC-0013). Flujo: email → magic link → `#access_token` en URL hash → `POST /api/auth/exchange-token` → cookie HttpOnly `housematch_session`. Middleware `tenantAuthMiddleware` valida via `supabase.auth.getUser(token)`, retorna 401 si inválido. Rate limit 5 req/min/IP en `request-magic-link`.

---

## 3. Arquitectura del Código y Estructura de Archivos

La aplicación está construida sobre **Node.js** utilizando **TypeScript** y el gestor de paquetes **pnpm**.

* `src/index.ts`: Punto de entrada del sistema. Inicializa el servidor Express, levanta las sesiones dinámicas de Baileys multi-tenant y despacha mensajes entrantes a la cola asíncrona.
* `src/services/coordinator.ts`: **Orquestador Principal**. Controla la idempotencia por ID nativo de WhatsApp, la deduplicación de 24 horas, la secuencia de ejecución de los sub-agentes y persiste los resultados iniciales en Supabase con `is_notified = false` (columna real confirmada por introspección; no existe `notification_status`).
* `src/services/ai.ts`: Implementa el patrón **Strategy** para proveedores de IA.
    * *Google Gemini Strategy (`gemini-2.5-flash-lite`)*: Modelo principal por costo y velocidad.
    * *OpenAI Strategy (`gpt-4o-mini`)*: Fallback dinámico automático configurado obligatoriamente con **Structured Outputs** (`json_schema`).
    * *Sub-Agentes Cognitivos:* **Agente 1 (Extractor)** con blindaje XML wrappers, **Agente 2 (Geolocalizador)** normalizador de zonas de Tucumán, y **Agente 3 (Validador)** filtro cualitativo de falsos positivos.
* `src/services/notifier.ts`: Hilo asíncrono en background que corre cada 10 minutos (WhatsApp). Consolida los matches pendientes por tenant, aplica delay de escritura humana (2-4s) y rota entre 5 plantillas estilísticas distintas para evitar baneo. **Dormido detrás de `NOTIFICATION_CHANNEL=whatsapp`** (SPEC-0014).
* `src/services/notifier-email.ts` *(SPEC-0014)*: Canal de notificación primario (`NOTIFICATION_CHANNEL=email`, default). Corre cada `NOTIFICATION_INTERVAL_MINUTES` (default 20), consolida por tenant/grupo igual que la versión WhatsApp, envía por email vía Resend a `profiles.email`, con deep links `wa.me` trackeados (pixel de apertura + redirect de click, columnas `email_opened_at`/`email_clicked_at` en `match_queue`).
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
* **SPEC-0014:** Notificación por email (Resend) como canal primario, detrás de `NOTIFICATION_CHANNEL`; WhatsApp queda intacto y dormido. Tracking de apertura/click sobre `match_queue` (`email_opened_at`/`email_clicked_at`). Schema drift de `match_queue` documentado en `docs/evolucion_proyecto/schema_actual.sql` vía introspección real (Supabase MCP). Suite de tests de `matcher.ts` (7 estrategias) agregada. Hardening: `.dockerignore`, `helmet`. Tests: 38/38 en verde. Email de prueba real confirmado recibido.
* **SPEC-0013:** Auth Supabase magic link — reemplaza OTP por WhatsApp. Endpoints `/api/auth/*` implementados (request-magic-link, exchange-token, session, logout). `tenantAuthMiddleware` usa `supabase.auth.getUser()`. Frontend: auth overlay con email input + callback handler de hash URL. Tests: 15/15 en verde.
* **SPEC-0012:** Refactor de esquema v2 — migración completa de tablas y campos a inglés, consolidación de `Message` en `match_queue`, reescritura de `supabaseAuth.ts` a patrón JSONB single-row, punto de extensión `resolvePropertyZoneId()`. Tests: 15/15 en verde.
* **SPEC-0011:** Arquitectura de propiedades centrada en base de datos (eliminación de Sheets y caché local en disco).
* **SPEC-0010:** Mitigación de deuda técnica (colas de mensajes por tenant), fugas de memoria (Supabase, WhatsApp huerfan timeouts) y cotización dinámica del Dólar Blue (DolarAPI).
* **SPEC-0009:** Refactorización de calidad, implementación del patrón Strategy en el Matcher, Structured Outputs en OpenAI y ordenamiento de directorios (`cache/`).

### Deuda Técnica y Próximos Pasos Activos
- [x] **Auth Supabase magic link (SPEC-0013):** Implementado. Endpoints activos, middleware con `supabase.auth.getUser()`, frontend actualizado.
- [x] **Notificación por email (SPEC-0014):** Implementado y verificado con envío real. `src/services/notifier-email.ts`, detrás de `NOTIFICATION_CHANNEL`.
- [x] **Tests de `matcher.ts` (SPEC-0014):** `tests/matcher.test.ts`, 7 estrategias cubiertas (match + reject cada una).
- [x] **Hardening básico (SPEC-0014):** `.dockerignore` y `helmet()` agregados y verificados contra el dashboard real.
- [x] **RLS habilitado (2026-07-02):** `profiles`, `properties`, `match_queue`, `whatsapp_sessions` con políticas `tenant_id`/`id = auth.uid()` (`TO authenticated`); `neighborhood_*` con RLS habilitado sin políticas (deny-all, no usadas por el código); `spatial_ref_sys` deliberadamente sin tocar (catálogo del sistema PostGIS). Detalle en `docs/evolucion_proyecto/schema_actual.sql`.
- [x] **Fuga cross-tenant en `/api/matches` (2026-07-02):** `GET /api/matches` y `POST /api/matches/:id/feedback` no filtraban por `tenant_id` — cualquier tenant autenticado podía ver/editar matches de otros. Ya corregido con `.eq('tenant_id', tenantId)`.
- [ ] **`tenantAuthMiddleware` no usa `getTenantClient()` (hallazgo 2026-07-02):** todo el tráfico vivo de la app pasa por el cliente service-role (bypassa RLS siempre). RLS hoy es defensa en profundidad si la anon key se filtra, pero no aísla tenants dentro del flujo real de la app. Cambiar el middleware para usar `getTenantClient()` es un cambio de arquitectura mayor, pendiente.
- [x] **`web_push_subscriptions` no existe en el schema real (KAN-19, resuelto 2026-07-14):** tabla creada en Supabase (`id`, `tenant_id` FK -> `profiles.id`, `subscription` jsonb, `created_at`) vía migración `create_web_push_subscriptions_table`, con RLS `tenant_id = auth.uid()` igual que `properties`/`match_queue`/`whatsapp_sessions`. Columnas alineadas al código real (`notifier.ts`, `POST /api/notifications/subscribe` en `src/index.ts`), no a la descripción original del ticket (que mencionaba `user_id`/`subscription_details`, inexistentes en el código). Sin cambios de código necesarios — el logging de errores en `notifier.ts` ya estaba implementado.
- [x] **Rama `feature/matching-ciego` creada (KAN-33, 2026-07-28):** Creada desde `development` (post-merge de KAN-32, commit `97dc9de`), sin diffs pendientes contra `development` y sin tocar `whatsapp.ts`/Baileys. Pusheada a origin, lista para alojar el desarrollo de matching ciego.
- [x] **Congelamiento de Baileys (KAN-32, 2026-07-28):** Sin altas de cuentas de WhatsApp nuevas y sin avance del cifrado de `auth_creds`, vía bandera condicional (no borrado de código). Bandera `BAILEYS_FROZEN` (`src/config/env.ts`, default `true` — hace falta `BAILEYS_FROZEN=false` explícito para descongelar). Se aplica en `initTenantSessionInternal` (`src/services/whatsapp.ts`): si `state.creds.registered` es `false` (tenant nunca terminó de emparejar un número, generaría un QR nuevo = alta de cuenta) y la bandera está activa, se bloquea con error y log `[WHATSAPP] Alta de cuenta ... bloqueada`. Los tenants ya emparejados (`registered: true`) siguen reconectando sin cambios. Diseño de cifrado en reposo de `auth_creds` (AES-256-GCM) documentado como bloque comentado en `src/services/supabaseAuth.ts`, sin dependencias nuevas ni código ejecutable. **Revisión de dependencias:** `@whiskeysockets/baileys` instalado en `7.0.0-rc13`, que coincide con el dist-tag `latest` del registro (no hay versión más nueva pendiente). Tests: 81/81 en verde (`tests/whatsapp.test.ts` cubre el default y el override de la bandera).
- [x] **Desconexión automática de sesiones de WhatsApp de prueba (KAN-53, 2026-07-28):** Nuevo servicio `src/services/sessionCleanup.ts`, en el mismo patrón de loop en segundo plano que `notifier-email.ts`. Diseño clave: como el schema real no tiene ninguna columna que distinga tenants "de prueba" de reales (ver sección 2 y `schema_actual.sql`), se usa una **allowlist explícita** vía `TEST_WHATSAPP_TENANT_IDS` (UUIDs separados por coma) en vez de cualquier heurística — así nunca se puede desconectar por error una sesión real, que era el riesgo central del ticket. Vacía por default: el servicio queda inactivo si no se configura ningún tenant de prueba. Frecuencia configurable vía `SESSION_CLEANUP_INTERVAL_MINUTES` (default 60 — justificado en comentario de `src/config/env.ts`: no son sesiones urgentes, y una cadencia horaria evita logins/logouts innecesarios de Baileys). Reutiliza `logoutTenantSession()` ya existente en `whatsapp.ts` (cierra el socket y limpia `whatsapp_sessions` en Supabase). Notificación a devs/testers: siempre queda logueada (`logger.warn`), y opcionalmente por email vía Resend a `DEV_ALERT_EMAIL` si está configurado junto con `SENDER_API_KEY`. Wireado en `src/index.ts` (`startSessionCleanupService()`, junto a los demás servicios de fondo). Tests: `tests/sessionCleanup.test.ts`, 88/88 en verde en la suite completa. Pendiente de este ticket (fuera del alcance de código): capacitación del equipo sobre el nuevo proceso.
- [ ] **Configuración Supabase Dashboard post-SPEC-0013:** Agregar `APP_URL` como Site URL y Redirect URL en Authentication → URL Configuration.
- [ ] **Dominio propio en Resend:** Hoy usa el sandbox `onboarding@resend.dev` (limitado a la casilla dueña de la cuenta, alta chance de caer en Spam). Verificar dominio propio para producción.
- [ ] **Matching espacial PostGIS:** Implementar polígonos de zonas en Supabase e integrar búsqueda espacial real en `resolvePropertyZoneId()` de `src/utils/matcher.ts` (hoy es un heurístico real de keywords, no un stub).
- [ ] **LangGraph:** Evaluar migración del flujo de agentes cognitivos a LangGraph para control de estado y reintentos más sofisticados.
- [ ] Conectar los nuevos endpoints de visualización multi-tenant en el Frontend asegurando que se filtre correctamente por el `tenant_id` (Asignado a: `@frontend`).