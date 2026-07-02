# Especificación 0014: Notificación por Email, Deuda Técnica y Schema Drift

Segunda ronda de refactor (`refactor_brief_2.md`). Agrega notificación de matches por email como fuente primaria (reemplazando a WhatsApp sin borrarlo), cierra deuda técnica de testing (`matcher.ts`), documenta el schema drift real de `match_queue`, y aplica hardening básico (`.dockerignore`, `helmet`).

---

## 1. Contexto y Motivación

En la sesión anterior se marcaron `spec_0012`/`spec_0013` como "Completado" con notificación por email incluida, sin que el código existiera. Esta ronda parte de una regla explícita: no marcar nada como terminado sin evidencia real (output de `pnpm test` pegado, un email real recibido y confirmado, columnas de base de datos confirmadas por introspección real, no supuestas).

Además, `match_queue` tenía columnas (`score`, `validation_score`, `is_valid`) agregadas manualmente en el dashboard de Supabase en algún momento, sin quedar nunca versionadas en ningún `.sql` del repo — drift de schema que había que documentar antes de seguir construyendo sobre la tabla.

---

## 2. Decisiones de Diseño (Técnico)

### A. Introspección real vía Supabase MCP (no supuestos)

Se conectó el MCP de Supabase (`.mcp.json`, servidor `https://mcp.supabase.com/mcp`) y se usó contra el proyecto real `bbadahhljpddlckyrmvi` (alias `matchouse`, confirmado igual a `SUPABASE_URL` del `.env`). Se confirmaron las 16 columnas reales de `match_queue` vía `information_schema.columns` + `list_tables(verbose=true)`, documentadas en `docs/evolucion_proyecto/schema_actual.sql`. Esto corrigió una creencia falsa en `.agent/CONTEXT.md`: no existen columnas `notification_status` ni `fecha` (nunca existieron en la base real; el código siempre usó `is_notified`/`created_at`).

**Hallazgo de seguridad, fuera de alcance de esta spec:** `list_tables` devolvió un advisory `critical` — las 8 tablas de `public` (incl. `match_queue`, `properties`, `profiles`) tienen **Row Level Security deshabilitado**, expuestas por completo a las claves anon/authenticated. No se aplicó remediation (activar RLS sin políticas bloquearía todo acceso); queda reportado para que se decida en otra sesión.

### B. `RESEND_API_KEY` vs `SENDER_API_KEY`

El brief pedía leer `RESEND_API_KEY` del `.env`, pero esa variable no existe — el `.env` real tiene `SENDER_API_KEY`. Decisión (confirmada con el usuario): tratar `SENDER_API_KEY` como la key de Resend ya cargada. `env.ts` lee `process.env.SENDER_API_KEY` hacia `config.resendApiKey`, sin renombrar la variable real (para no romper el entorno ya configurado).

### C. Canal de notificación desacoplado (`NOTIFICATION_CHANNEL`)

`src/services/notifier.ts` (WhatsApp) **no se tocó** — queda dormido detrás de `NOTIFICATION_CHANNEL=whatsapp`. Se agregó `src/services/notifier-email.ts` como implementación paralela, con la misma lógica de consolidación (agrupar por `tenant_id` y luego por `whatsapp_group_name`, mismo filtro `is_notified=false && is_valid=true && score>=70`). El switch vive en `main()` (`src/index.ts`), nunca corren los dos servicios a la vez. Default: `email` (fuente primaria según el brief).

### D. Tracking de apertura/click sobre `match_queue`

Se agregaron dos columnas nuevas vía migración real (`mcp__supabase__apply_migration`, nombre `add_email_notification_tracking_columns`): `email_opened_at`, `email_clicked_at` (ambas `timestamptz`, nullable). Se extendió `match_queue` en vez de crear una tabla nueva (menos invasivo, ya tiene el `id` necesario). Dos endpoints nuevos sin auth (los pega el cliente de email, no un tenant logueado): `GET /api/notifications/email/pixel/:matchId.gif` (pixel 1x1, marca apertura) y `GET /api/notifications/email/click/:matchId` (resuelve el `wa.me` real desde `match_queue`+`property`, marca click, `302` redirect).

### E. Hardening

`.dockerignore` nuevo (espeja `.gitignore`). `helmet()` agregado en `src/index.ts` inmediatamente después de crear el `app` de Express, antes del resto de middleware.

---

## 3. Impacto en Componentes

- `docs/evolucion_proyecto/schema_actual.sql` **[NUEVO]** — DDL real de `match_queue` confirmado por introspección.
- `.agent/CONTEXT.md` **[MODIFY]** — corrección de columnas de `match_queue`.
- `src/config/env.ts` **[MODIFY]** — `resendApiKey`, `notificationChannel`, `notificationIntervalMinutes`.
- `.env.example` **[MODIFY]** — nueva sección de notificaciones.
- `src/services/notifier-email.ts` **[NUEVO]** — notifier por email vía Resend.
- `src/services/notifier.ts` — sin cambios (intacto, detrás del flag).
- `src/index.ts` **[MODIFY]** — endpoints de tracking, switch de canal en `main()`, `helmet()`.
- `resend_implementation.md` **[NUEVO]** — guía de configuración de Resend.
- `tests/matcher.test.ts` **[NUEVO]** — 14 casos (match + reject) para las 7 estrategias.
- `tests/notifier-email.test.ts` **[NUEVO]** — HTML, agrupación por tenant/grupo, flag de canal.
- `tests/runner.ts` **[MODIFY]** — wiring de los dos test files nuevos.
- `.dockerignore` **[NUEVO]**.

---

## 4. Estado de Implementación

- **Status: Completado**
- **Tests:** 38/38 en verde. Output real completo:

```
$ ts-node tests/runner.ts
TAP version 13
# Subtest: Supabase Client Cache - Debería retornar el mismo cliente para el mismo token
ok 1 - Supabase Client Cache - Debería retornar el mismo cliente para el mismo token
# Subtest: Isolated Multi-Tenant Queue - Las colas de cada tenant no deberían bloquearse entre sí
ok 2 - Isolated Multi-Tenant Queue - Las colas de cada tenant no deberían bloquearse entre sí
# Subtest: Dolar Service - Debería retornar cotizaciones válidas y persistir caché
ok 3 - Dolar Service - Debería retornar cotizaciones válidas y persistir caché
# Subtest: Matcher - Conversión dinámica usando cotización dinámica de dólar
ok 4 - Matcher - Conversión dinámica usando cotización dinámica de dólar
# Subtest: AI Service - Debería exportar las funciones clave
ok 5 - AI Service - Debería exportar las funciones clave
# Subtest: Coordinator Service - Debería guardar y recuperar catálogos en memoria por tenant
ok 6 - Coordinator Service - Debería guardar y recuperar catálogos en memoria por tenant
# Subtest: Dolar Service - Debería retornar cotizaciones y tener un fallback inicial
ok 7 - Dolar Service - Debería retornar cotizaciones y tener un fallback inicial
# Subtest: Excel Service - Debería retornar catálogo vacío o lanzar error para buffers sin datos
ok 8 - Excel Service - Debería retornar catálogo vacío o lanzar error para buffers sin datos
# Subtest: Excel Service - Debería exportar función de sincronización de base de datos
ok 9 - Excel Service - Debería exportar función de sincronización de base de datos
# Subtest: Logger Service - Debería estar inicializado y tener niveles de logging
ok 10 - Logger Service - Debería estar inicializado y tener niveles de logging
# Subtest: Matcher - OperationMatchingStrategy: matchea con la misma operación
ok 11 - Matcher - OperationMatchingStrategy: matchea con la misma operación
# Subtest: Matcher - OperationMatchingStrategy: rechaza con operación distinta
ok 12 - Matcher - OperationMatchingStrategy: rechaza con operación distinta
# Subtest: Matcher - PropertyTypeMatchingStrategy: matchea con el mismo tipo de propiedad
ok 13 - Matcher - PropertyTypeMatchingStrategy: matchea con el mismo tipo de propiedad
# Subtest: Matcher - PropertyTypeMatchingStrategy: rechaza con tipo de propiedad distinto
ok 14 - Matcher - PropertyTypeMatchingStrategy: rechaza con tipo de propiedad distinto
# Subtest: Matcher - CountryMatchingStrategy: matchea cuando se pide country y la propiedad está en uno
ok 15 - Matcher - CountryMatchingStrategy: matchea cuando se pide country y la propiedad está en uno
# Subtest: Matcher - CountryMatchingStrategy: rechaza cuando se pide country y la propiedad no está en uno
ok 16 - Matcher - CountryMatchingStrategy: rechaza cuando se pide country y la propiedad no está en uno
# Subtest: Matcher - resolvePropertyZoneId: no es un stub, clasifica por keywords reales
ok 17 - Matcher - resolvePropertyZoneId: no es un stub, clasifica por keywords reales
# Subtest: Matcher - ZoneMatchingStrategy: matchea cuando la zona resuelta coincide con la del zoneIntent
ok 18 - Matcher - ZoneMatchingStrategy: matchea cuando la zona resuelta coincide con la del zoneIntent
# Subtest: Matcher - ZoneMatchingStrategy: rechaza cuando la zona resuelta no coincide con la del zoneIntent
ok 19 - Matcher - ZoneMatchingStrategy: rechaza cuando la zona resuelta no coincide con la del zoneIntent
# Subtest: Matcher - BedroomsMatchingStrategy: matchea con la misma cantidad de dormitorios
ok 20 - Matcher - BedroomsMatchingStrategy: matchea con la misma cantidad de dormitorios
# Subtest: Matcher - BedroomsMatchingStrategy: rechaza cuando faltan dormitorios
ok 21 - Matcher - BedroomsMatchingStrategy: rechaza cuando faltan dormitorios
# Subtest: Matcher - BudgetMatchingStrategy: matchea cuando el precio está dentro del presupuesto
ok 22 - Matcher - BudgetMatchingStrategy: matchea cuando el precio está dentro del presupuesto
# Subtest: Matcher - BudgetMatchingStrategy: rechaza cuando el precio excede el presupuesto (fuera del margen del 5%)
ok 23 - Matcher - BudgetMatchingStrategy: rechaza cuando el precio excede el presupuesto (fuera del margen del 5%)
# Subtest: Matcher - FeaturesMatchingStrategy: matchea sin penalización cuando todas las características coinciden
ok 24 - Matcher - FeaturesMatchingStrategy: matchea sin penalización cuando todas las características coinciden
# Subtest: Matcher - FeaturesMatchingStrategy: penaliza fuertemente el score cuando ninguna característica coincide
ok 25 - Matcher - FeaturesMatchingStrategy: penaliza fuertemente el score cuando ninguna característica coincide
# Subtest: Notifier Service - Debería exponer funciones de inicio y envío consolidado
ok 26 - Notifier Service - Debería exponer funciones de inicio y envío consolidado
# Subtest: Web Push - Debería tener configurado VAPID correctamente
ok 27 - Web Push - Debería tener configurado VAPID correctamente
# Subtest: Notifier Email - expone las funciones esperadas
ok 28 - Notifier Email - expone las funciones esperadas
# Subtest: Notifier Email - buildWhatsAppMessage incluye domicilio y precio de la propiedad
ok 29 - Notifier Email - buildWhatsAppMessage incluye domicilio y precio de la propiedad
# Subtest: Notifier Email - buildPropertyRowHtml arma el HTML con los datos de la propiedad y el link de click
ok 30 - Notifier Email - buildPropertyRowHtml arma el HTML con los datos de la propiedad y el link de click
# Subtest: Notifier Email - buildEmailHtml consolida varias propiedades y agrega el pixel de apertura
ok 31 - Notifier Email - buildEmailHtml consolida varias propiedades y agrega el pixel de apertura
# Subtest: Notifier Email - groupMatchesByTenant agrupa correctamente por tenant_id
ok 32 - Notifier Email - groupMatchesByTenant agrupa correctamente por tenant_id
# Subtest: Notifier Email - groupMatchesByWhatsAppGroup agrupa correctamente por grupo de WhatsApp
ok 33 - Notifier Email - groupMatchesByWhatsAppGroup agrupa correctamente por grupo de WhatsApp
# Subtest: Notifier Email - NOTIFICATION_CHANNEL respeta el flag de canal (default email, explícito whatsapp)
ok 34 - Notifier Email - NOTIFICATION_CHANNEL respeta el flag de canal (default email, explícito whatsapp)
# Subtest: Notifier Email - __setResendClientForTests permite inyectar un mock (nunca se manda mail real en el test suite)
ok 35 - Notifier Email - __setResendClientForTests permite inyectar un mock (nunca se manda mail real en el test suite)
# Subtest: Supabase Service - Debería exportar funciones de generación de JWT y cliente
ok 36 - Supabase Service - Debería exportar funciones de generación de JWT y cliente
# Subtest: Supabase Auth Service - Debería exportar funciones para auth de Baileys
ok 37 - Supabase Auth Service - Debería exportar funciones para auth de Baileys
# Subtest: WhatsApp Service - Debería estar listo para administrar sesiones y hooks
ok 38 - WhatsApp Service - Debería estar listo para administrar sesiones y hooks
1..38
# tests 38
# suites 0
# pass 38
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2206.1769
```

- **Email de prueba real:** confirmado. Se insertó una fila de prueba en `match_queue` (marcada `[TEST spec_0014]`, borrada después), se disparó `sendConsolidatedEmailNotifications()` manualmente, Resend devolvió `emailId: 15cabac4-d1db-4ae8-a6aa-bea3a7aa0bb0`, y `resend.emails.get(id)` confirmó `last_event: "delivered"` (ruteado por Amazon SES) a `r.loboplaza14@gmail.com`. El usuario confirmó la recepción real ("ahi llego") — cayó en Spam, esperable con el dominio compartido `onboarding@resend.dev` sin reputación propia (ver `resend_implementation.md`).
- **Columnas reales de `match_queue`:** confirmadas por introspección MCP, ver tabla completa en `docs/evolucion_proyecto/schema_actual.sql`. 18 columnas totales (16 originales + 2 de tracking agregadas en esta sesión): `id`, `tenant_id`, `property_id`, `whatsapp_group_name`, `whatsapp_sender_name`, `whatsapp_sender_phone`, `raw_message_text`, `is_notified`, `created_at`, `score`, `validation_score`, `is_valid`, `reasoning`, `match_details`, `user_review_status`, `feedback_reason`, `email_opened_at`, `email_clicked_at`.
- **Fecha de cierre:** 2026-07-02

---

## 5. Pendientes para Siguiente Sesión

- **RLS deshabilitado en las 8 tablas de `public`** (advisory `critical` de Supabase) — evaluar políticas y activar RLS. No abordado en esta sesión (fuera de alcance del brief).
- Verificar un dominio propio en Resend para producción (hoy usa el sandbox `onboarding@resend.dev`, limitado a la casilla dueña de la cuenta y con alta chance de caer en Spam).
- El pixel de apertura se asocia solo al primer match de cada lote consolidado (aproximación a nivel de envío, no de apertura por-propiedad) — si se necesita granularidad exacta por propiedad, requeriría un pixel por fila.
- Matching espacial PostGIS (`resolvePropertyZoneId()` sigue como heurístico de keywords, no PostGIS real) — fuera de alcance de esta ronda.
- Paso manual pendiente de SPEC-0013 (Supabase Dashboard → Authentication → URL Configuration) — no tocado, es para el humano.
