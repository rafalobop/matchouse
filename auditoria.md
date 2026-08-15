# Auditoría pre-producción — Brokaza

Fecha: 2026-08-15 (actualización de la auditoría del 2026-08-14). Alcance: `src/` completo (backend Express, dashboard tenant, panel admin, servicios de matching/zonas), configuración de entorno y dependencias. No incluye `src/graph/*` (tooling interno de desarrollo, fuera del producto). Esta versión agrega foco explícito en **fugas de información**, **escalabilidad para 500-1000 usuarios** y **mantenibilidad**, y verifica el estado de cada ítem de la auditoría anterior contra el código actual.

Cada ítem tiene: **qué es el riesgo**, **por qué importa**, **dónde está** (archivo:línea) y **cómo mitigarlo**. Priorizado para que puedas resolver de arriba hacia abajo antes de salir a producción.

---

## ✅ Resuelto desde la auditoría anterior (2026-08-14)

De los 18 ítems originales, **6 ya están resueltos** — los 4 críticos y 2 de los 5 altos:

| # original | Ítem | Evidencia del fix |
|---|---|---|
| 1 | Fail-fast si faltan credenciales de Supabase | `src/config/env.ts:127-137` lanza error al arrancar salvo `ALLOW_MISSING_SUPABASE_CREDENTIALS=true`; `src/services/supabase.ts:18-30` usa un Proxy stub para que el error salte en el primer uso real. |
| 2 | Rate limiters 100% en memoria de proceso | `src/utils/rateLimit.ts:68-94` — nuevo `createDistributedRateLimiter` respaldado por RPC de Postgres (`rate_limit_check`), usado en auth, `/api/search`, `/api/upload` y admin-auth. Ver ítem nuevo #7 más abajo: el WS hub de notificaciones **no** recibió el mismo tratamiento. |
| 3 | Memory leak en `tenantClientsCache` | `src/services/supabase.ts:63-125` — TTL de 30 min + barrido periódico cada 5 min (`setInterval(...).unref()`). |
| 4 | Fuga de stack traces sin `NODE_ENV` forzado | `src/utils/errorHandler.ts` (`globalErrorHandler`) devuelve siempre JSON genérico, montado al final de todas las rutas; `src/utils/nodeEnvCheck.ts` además avisa si `NODE_ENV` no es `production`. Ver ítem nuevo #2: hay una fuga *distinta* de mensajes de error que este handler no cubre. |
| 5 | `xlsx` con vulnerabilidad sin parche en npm | `package.json:35` apunta al tarball oficial parcheado de SheetJS (`cdn.sheetjs.com`), no al registry de npm. |
| 6 | Sentry captura bodies HTTP completos | `instrument.js` + `src/config/sentryDataCollection.ts` — `httpBodies: []`, deniega cookies de sesión y headers sensibles (`authorization`, `cookie`, `x-internal-secret`) en request y response. |

Los 12 ítems restantes de la auditoría original (#7 a #18) **siguen sin resolver y siguen siendo válidos tal como estaban descritos** — se re-listan más abajo con su numeración nueva, integrados con los hallazgos frescos de esta pasada.

---

## 🔴 CRÍTICO — bloqueante antes de producción (o antes de escalar a 500-1000 usuarios)

### 1. ✅ RESUELTO (KAN-128) — Polling del dashboard cada 2 segundos — no soporta 500-1000 usuarios concurrentes
`src/dashboard/app.js:432-435` — cada pestaña de dashboard abierta corre **4 `setInterval` simultáneos**: `loadMatches` cada **2000ms**, `loadCatalogInfo` cada 5000ms, `loadActiveSearches` e `loadIncomingMatches` cada 10000ms cada uno. `src/admin-dashboard/app.js:117` agrega un quinto poll (`loadMetrics`) por cada pestaña de admin abierta.

**Riesgo:** con 500-1000 pestañas de dashboard abiertas simultáneamente, solo `loadMatches` genera **250-500 requests/segundo sostenidos** contra el proceso Node + Supabase; sumando los otros tres intervalos, el total ronda los **400-800 req/s** solo de polling, antes de contar tráfico real de búsquedas/uploads. Esto es, por lejos, el mayor riesgo de capacidad de toda la aplicación al llegar a la escala objetivo — dwarfa cualquier otro hallazgo de este documento.

El WebSocket hub (`src/services/realtimeHub.ts`, KAN-88) ya empuja eventos en tiempo real, pero el propio código deja el polling como mecanismo primario, no como fallback (`src/dashboard/app.js:463-467`).

**Fix:** invertir la relación — usar el push por WebSocket como señal primaria y el polling como fallback de baja frecuencia (2s → 15-30s como piso, no como default). Es el cambio de mayor impacto por esfuerzo de todo este documento.

### 2. ✅ RESUELTO (KAN-129) — Mensajes de error internos (Postgres/Supabase) filtrados al cliente en 12 rutas de `src/index.ts`
Patrón repetido: `res.status(500).json({ error: error.message || 'texto genérico' })`. Confirmado en `src/index.ts:395, 438, 532, 621, 829, 901, 962, 1016, 1042, 1069, 1129, 1171`. Como `error` suele ser el error crudo que devuelve Supabase/PostgREST (`throw error` unas líneas antes en cada caso), esto puede filtrar nombres de constraints, columnas o fragmentos de query directamente en el body de la respuesta HTTP — por ejemplo en `GET /api/searches` (901), `GET /api/matches` y `/api/matches/incoming` (1042/1069), `POST /api/matches/:id/feedback` (1129).

**Esto es distinto del error handler global (ítem ya resuelto #4/antiguo #4):** ese handler solo atrapa excepciones verdaderamente no capturadas; estos son `catch` explícitos dentro de cada ruta que responden *antes* de llegar al handler global, así que el fix de KAN-124 no los cubre.

Como contraste, `src/adminRoutes.ts` sí lo hace bien en sus 8 bloques `catch`: loguea `err.message` pero responde siempre con un string genérico al cliente.

**Fix:** en los 12 sitios listados, sacar `error.message ||` de la respuesta JSON al cliente (dejar solo el string de fallback) y mantener `error.message` únicamente en el `logger.error(...)` que ya está bien hecho al lado. Es un cambio mecánico, ~20 minutos.

### 3. Verificar que `APP_URL` en Supabase Vault no sea el placeholder de desarrollo
Según `docs/evolucion_proyecto/schema_actual.sql`, el trigger `property_uploaded_trigger` usa `pg_net` para llamar a `POST /internal/property-match-check` usando la URL guardada en Supabase Vault bajo la clave `APP_URL`. Si esa entrada quedó con el valor de desarrollo (`http://localhost:3000`), el matching cartera→búsqueda (uno de los dos sentidos del matching) falla en silencio en producción — no hay error visible para el usuario ni para el operador, simplemente esa dirección de matching deja de generar resultados.

**Fix:** antes de lanzar (y como chequeo en cada entorno nuevo), verificar en la consola de Supabase (Database → Vault) que `APP_URL` apunte al dominio público real de producción. Agregar este chequeo a la checklist de deploy — es fácil de olvidar porque no falla ningún build ni test.

**Clasificación:** 100% fuera de código. Se resuelve en **Supabase Console → Database → Vault**, no en el repo. No amerita un ticket de dev — va como ítem de checklist de deploy.

---

## 🟠 ALTO — resolver antes o muy cerca del lanzamiento

### 4. Patrón N+1 en `GET /api/properties` del panel admin *(ítem original #7, no resuelto)*
`src/adminRoutes.ts:217-235` — por cada una de las hasta 50 propiedades de una página, se llama `resolvePropertyZoneInfo()`, que dispara hasta 2 round-trips a Postgres por propiedad. Una sola carga de página puede disparar ~100 llamadas a Supabase en paralelo.

**Fix:** batchear con un RPC que reciba un array de `(lat, lon)` y devuelva todas las zonas en una sola llamada, o precalcular/cachear `zone_id` en la tabla `properties`.

**Clasificación:** código + base de datos. El llamado desde `src/adminRoutes.ts` es código normal, pero el RPC batch (o la columna `zone_id` nueva) requiere una migración SQL corrida en **Supabase → SQL Editor / migraciones**. Se puede armar como un solo ticket de backend que incluya la migración.

### 5. El panel admin usa siempre la clave service-role, sin autorización granular *(ítem original #8, no resuelto)*
Todas las rutas de `src/adminRoutes.ts` usan el cliente con **service-role**, que ignora RLS. Solo la corrección de coordenadas queda auditada en `admin_audit_log` (`:285-295`); las lecturas de `/api/metrics` y `/api/properties` no dejan rastro de quién miró qué, y no hay roles diferenciados (soporte vs. superadmin).

**Fix (progresivo):** loguear también los accesos de lectura, y planear roles diferenciados antes de sumar operadores admin adicionales.

**Clasificación:** código + decisión de producto. Loguear lecturas en `admin_audit_log` es un ticket de backend directo. Los roles diferenciados (soporte vs. superadmin) no tienen sentido codificarlos hasta definir qué roles van a existir — eso es una conversación de equipo, no algo que resuelva un dev solo.

### 6. Falta rate limiting en endpoints admin autenticados *(ítem original #9, no resuelto)*
`GET /api/metrics`, `GET /api/properties` y `PATCH /api/properties/:id/coordinates` (`src/adminRoutes.ts:160,193,244`) no tienen rate limiter propio — solo el login (`adminAuthRateLimiter`) lo tiene. Una cuenta admin comprometida puede hacer scraping masivo del catálogo de todos los tenants sin fricción.

**Fix:** aplicar `createDistributedRateLimiter` (por `adminUserId`) a las rutas autenticadas del panel admin — la infraestructura para esto ya existe desde el fix del ítem #2 original.

**Clasificación:** 100% código. Un ticket de backend directo, sin dependencias externas — la infra del rate limiter ya existe.

### 7. El hub de WebSocket de notificaciones es por-proceso — se rompe en silencio al escalar horizontalmente
`src/services/realtimeHub.ts:16` — `tenantSockets` es un `Map` en memoria del proceso, con el mismo patrón que ya se identificó y corrigió para los rate limiters (ítem original #2). Si en algún momento corren 2+ instancias detrás de un load balancer, el socket de un tenant conecta a la instancia que le tocó, pero un match creado por un request servido en *otra* instancia nunca llega a ese socket — `broadcastMatchCountChanged` solo ve los sockets de su propio proceso.

**Riesgo:** degrada con gracia (el polling de fallback del ítem #1 sigue funcionando), pero la UX de "tiempo real" deja de funcionar en silencio para una fracción de usuarios proporcional al número de instancias, sin ningún error visible.

**Fix:** cuando se agregue una segunda instancia (el mismo trigger que el ítem #2 original), resolver junto con eso mediante un relay entre instancias — Postgres `LISTEN/NOTIFY` o Redis pub/sub.

**Clasificación:** código + infraestructura. El relay en sí (`src/services/realtimeHub.ts`) es un ticket de backend, pero solo importa el día que se decida correr 2+ instancias en **Railway** — y si se elige Redis en vez de Postgres `LISTEN/NOTIFY`, hay que aprovisionar esa instancia fuera del repo (Upstash, plugin de Railway, etc.).

### 8. Segmentos de búsqueda se procesan en serie, no en paralelo
`src/index.ts:818-831` (`POST /api/search`) — cuando `segmentSearchRequests` divide una consulta en varios segmentos, cada uno se espera **secuencialmente** en un `for` loop, y cada segmento hace su propia llamada paga a IA más queries a la base. Una búsqueda de 3 segmentos tarda ~3x la latencia de un segmento en vez de correr en paralelo, manteniendo la conexión HTTP (y el presupuesto de rate limit del tenant) abierta proporcionalmente más tiempo.

**Fix:** `Promise.all`/`Promise.allSettled` sobre los segmentos en vez del loop `for...await` (el `catch` actual ya degrada por segmento individualmente, así que `allSettled` mantiene ese comportamiento).

**Clasificación:** 100% código. Cambio autocontenido en `src/index.ts`, sin dependencias externas.

### 9. `findCrossTenantMatches` hace `select('*')` sin límite en cada búsqueda
`src/services/blindMatching.ts:115-118` — `select('*').neq('tenant_id', tenantId)` trae **todas** las propiedades de todos los otros tenants en cada `POST /api/search`, y además una vez por cada búsqueda activa dentro de `GET /api/searches` (`src/index.ts:878`). No es una fuga de información (el filtro de tenant está bien aplicado), pero es una lectura de tabla completa + scan en memoria por request — el mismo patrón de raíz que el N+1 del ítem #4, pero en el camino caliente de cara al tenant, no en el panel admin.

**Fix:** acotar con `.limit()` + paginación, o mover el filtrado geográfico/de criterios a un RPC que filtre en la base en vez de traer todo y filtrar en Node.

**Clasificación:** código, con una variante que toca base de datos. Un `.limit()` simple es 100% código (`src/services/blindMatching.ts`). Si en cambio se opta por mover el filtro a un RPC, agrega una migración SQL en **Supabase**.

### 10. No hay CI — build y tests no se validan antes de mergear
No existe `.github/workflows`. `npm run build` (tsc) y `npm test` (39 archivos bajo `tests/`, corridos con un runner propio) nunca se ejecutan automáticamente sobre un PR — todo es manual. Con más tráfico y, presumiblemente, más gente tocando el código a medida que el producto crece, un build roto o un test que empieza a fallar puede mergearse sin que nadie lo note hasta que ya está en producción.

**Fix:** agregar un workflow mínimo de GitHub Actions que corra `npm ci && npm run build && npm test` en cada PR. Es barato (horas, no días) y es el cambio de mantenibilidad de mayor apalancamiento disponible.

**Clasificación:** código de configuración (vive en el repo, `.github/workflows/ci.yml`, pero no es lógica de negocio) + un paso opcional fuera del repo: activar "required status checks" en la protección de la rama `development`/`main` desde **GitHub → Settings → Branches**, para que el CI realmente bloquee merges y no sea solo informativo.

---

## 🟡 MEDIO — importante, no bloqueante

### 11. Falta validación de tamaño/whitelist en el body JSON global *(ítem original #10, no resuelto)*
`src/index.ts:91` y `src/adminRoutes.ts:48` siguen usando `express.json()` sin `{ limit: ... }` explícito.

**Fix:** declarar `express.json({ limit: '256kb' })` (o el valor que corresponda) explícitamente.

**Clasificación:** 100% código. Dos líneas en `src/index.ts` y `src/adminRoutes.ts`.

### 12. PII en logs de texto plano sin redacción *(ítem original #11, no resuelto)*
`src/services/logger.ts:3-7` no tiene `redact`. `src/index.ts` sigue logueando `email` en texto plano en múltiples líneas (270, 273, 277, 293, 296, 299, 302, 343).

**Fix:** usar `redact: ['email', '*.email']` en la config de Pino, o loguear un hash/prefijo del email.

**Clasificación:** 100% código. Cambio de config en `src/services/logger.ts`.

### 13. Atributo `title` sin escapar en el panel admin *(ítem original #12, no resuelto)*
`src/admin-dashboard/app.js:146` sigue interpolando `zone.name`/`textSuggestedZone.name` sin `escapeHtml()`, a diferencia de `address` en la línea 188 que sí lo hace.

**Fix:** pasar ambos valores por `escapeHtml()`.

**Clasificación:** 100% código. Una línea en `src/admin-dashboard/app.js:146` — ticket de frontend.

### 14. CSP depende de tiles gratuitos de OpenStreetMap sin proxy propio *(ítem original #13, no resuelto)*
`src/index.ts:86` sigue permitiendo `https://*.tile.openstreetmap.org` en `img-src` sin proxy/caché propio.

**Fix:** no urgente con pocos operadores admin; migrar a un proveedor con SLA antes de uso intensivo del mapa.

**Clasificación:** código + servicio externo. Cambiar la directiva CSP y la URL de tiles en `src/index.ts` es código, pero antes hace falta **crear una cuenta y conseguir una API key** en un proveedor (Mapbox, MapTiler) — eso es una gestión fuera del repo que bloquea al ticket de código.

### 15. Excel de subida se procesa de forma síncrona en el event loop *(ítem original #14, no resuelto)*
`src/index.ts:514,601` siguen llamando `processExcelBufferWithColumnMap` de forma síncrona dentro del handler. No se encontró uso de `worker_threads` en el repo.

**Fix:** mover el parseo a un worker thread o job en background si el catálogo promedio crece.

**Clasificación:** 100% código. Cambio en `src/index.ts` (introducir `worker_threads` o mover el parseo a un job).

### 16. Sin test de carga ni métricas de latencia en producción *(ítem original #15, no resuelto)*
No hay `k6`/`autocannon` ni APM de performance en el repo.

**Fix:** al menos una corrida de carga básica sobre `/api/search` antes de anunciar el lanzamiento — y repetirla después de resolver el ítem #1 (polling), que es el que más va a mover la aguja de capacidad real.

**Clasificación:** código ya resuelto + ejecución fuera del repo. El script de load test (`scripts/load-test-dashboard.ts`) ya existe desde KAN-128 — lo que falta es **correrlo desde una máquina separada contra staging/producción real** (no es un ticket de dev, es una tarea operativa). El APM de latencia continua (opcional) es una decisión de herramienta/costo a evaluar por fuera del repo (ej. Better Stack, Datadog).

### 17. README describe una arquitectura que ya no existe
`README.md:1-30` describe un modelo de "OTP con binding de IP", un `coordinator.ts` orquestador y un flujo multi-agente por WhatsApp — nada de eso existe hoy (no hay `coordinator.ts`; la auth actual es magic-link + sesión JWT vía `tenantAuthMiddleware`, `src/index.ts:186`). Además enlaza a rutas `file:///c:/Users/...` de otra máquina. Un desarrollador nuevo que lea el README hoy se forma un modelo mental incorrecto de cómo funciona el sistema.

**Fix:** reescribir el README describiendo la auth actual, las rutas actuales, y cómo correr `npm run dev`/`npm test`/`npm run build`. Bajo esfuerzo, alto impacto en onboarding.

**Clasificación:** documentación, no código de aplicación. Vive en el repo (`README.md`) pero no toca `src/` — ticket chico, cualquiera de las dos personas lo puede escribir.

### 18. Assets estáticos del dashboard sin cache-control ni CDN
`src/index.ts:150-151` — `express.static` sirve `public/` y el bundle del dashboard desde el mismo proceso Node que atiende `/api/*`, sin headers `Cache-Control`/`immutable` visibles y sin CDN delante. A escala actual no es un problema; con 500-1000 usuarios cargando JS/CSS/imágenes en cada visita al dashboard, agrega carga evitable al mismo proceso que sirve la API.

**Fix:** `express.static(..., { maxAge: '1y', immutable: true })` para assets con hash, o un CDN/reverse-proxy delante — no es prioritario si el ítem #1 (polling) ya reduce la carga total sobre el proceso.

**Clasificación:** código, con una mejora opcional fuera del repo. El header `Cache-Control` es una línea en `src/index.ts`. El CDN (Cloudflare u otro) es infraestructura a contratar/configurar por fuera, no bloqueante.

### 19. Alta densidad de `any` en archivos calientes
Pese a `"strict": true` en `tsconfig.json`, hay uso concentrado de `any`: `src/index.ts` (38 ocurrencias), `src/services/ai.ts` (17), `src/adminRoutes.ts` (13), `src/services/blindMatching.ts` (9). Es justo donde los resultados de queries a Supabase y las respuestas de IA pierden tipado — el lugar donde una respuesta con forma inesperada puede producir un `undefined` silencioso en vez de un error de tipo detectado en build.

**Fix:** no es necesario eliminarlo todo antes del lanzamiento; priorizar tipar los resultados de Supabase con `supabase gen types typescript`, que es la fuente de mayor densidad de `any` y toca directamente la forma de los datos de producción.

**Clasificación:** 100% código. `supabase gen types typescript` es un comando de CLI cuyo resultado se commitea como código TS — no requiere tocar nada fuera del repo.

---

## 🟢 BAJO — mejoras, no bloqueantes

### 20. Falta límite superior de paginación en `GET /api/matches` y `/api/matches/incoming` *(ítem original #16, no resuelto)*
`src/index.ts:1033,1060` siguen con `.limit(50)` fijo, sin paginación real.

**Clasificación:** 100% código. Agregar `page`/`cursor` a `src/index.ts`.

### 21. `console.log`/`console.error` mezclados con el logger estructurado (Pino) *(ítem original #17, no resuelto)*
Sigue presente en varios puntos de `src/index.ts` (58, 62, 531, 620, 1128, 1170, 1185, 1203-1205, 1211) — incluso en código relativamente nuevo: los handlers de `unhandledRejection`/`uncaughtException` (58/62) usan `console.error` crudo en vez de `logger`.

**Clasificación:** 100% código. Reemplazar por `logger` en los puntos listados.

### 22. No hay chequeo de salud (`/health`) dedicado *(ítem original #18, no resuelto)*
No se encontró un endpoint de healthcheck simple y sin autenticación. Solo existe `/api/status`, que es la verificación de sesión del tenant, no un liveness check de proceso.

**Clasificación:** código + configuración de plataforma. Agregar la ruta `/health` es código (`src/index.ts`); apuntar el healthcheck de **Railway** a esa ruta en vez de `/` se configura en el Settings del servicio en Railway, fuera del repo.

### 23. `src/index.ts` es un monolito de 1212 líneas con 22 rutas inline
Routing, middleware de auth, validación y lógica de negocio conviven en un solo archivo (23 bloques `try/catch` inline). Comparar con `src/adminRoutes.ts` (342 líneas, 8 rutas), mucho más fácil de revisar en un PR. No es una crisis hoy — la mayoría de la lógica pesada ya está delegada a `src/services/*` — pero se vuelve más difícil de revisar de forma segura a medida que crece.

**Fix (incremental, no una reescritura):** la próxima vez que se toque una ruta, extraerla a `src/routes/*.ts` agrupado por dominio (auth, upload, matches, search), siguiendo el modelo que ya da `adminRoutes.ts`.

**Clasificación:** 100% código. Refactor incremental, sin dependencias externas.

### 24. Dashboards de frontend son JS vanilla sin bundler ni módulos
`src/dashboard/app.js` tiene 1679 líneas con ~80 variables globales de nivel superior conectadas directo a `document.getElementById`; `src/admin-dashboard/app.js` es más chico (314 líneas) y más sano. Sin build step, sin framework, sin límites de módulo — frágil de modificar sin generar regresiones (un id de DOM renombrado rompe en runtime, no en build).

**Fix (no urgente):** no vale la pena migrar a un framework antes del lanzamiento, pero si el dashboard de tenant sigue creciendo, conviene partir `app.js` en unos pocos módulos (`auth.js`, `upload.js`, `matches.js`) cargados como ES modules.

**Clasificación:** 100% código. Refactor de frontend, sin dependencias externas.

### 25. Un objeto `SupabaseClient` persistente por token de sesión — vigilar si se agrega `.channel()`
`src/services/supabase.ts:85-103` (`getTenantClient`) ya está acotado con TTL de 30 min (fix del ítem original #3). Con 500-1000 tenants concurrentes, esto implica 500-1000 objetos `SupabaseClient` vivos en memoria simultáneamente, cada uno configurado con transporte `ws` para realtime. Se confirmó que hoy **ningún** código llama a `.channel()`/`.subscribe()` sobre estos clientes — si eso cambiara en el futuro, cada cliente abriría un WebSocket real hacia Supabase, multiplicando conexiones abiertas por cantidad de tenants. Hoy es solo overhead de memoria de objeto, aceptable a esta escala.

**Fix:** ninguno necesario ahora; solo vigilar si se introduce uso de `.channel()` sobre `getTenantClient()`.

**Clasificación:** ninguna acción de código hoy. Es un ítem de vigilancia en code review — solo se activa (y ahí sí sería 100% código) si algún PR futuro agrega `.channel()`/`.subscribe()` sobre `getTenantClient()`.

---

## Verificaciones puntuales que salieron limpias (para que no haya que volver a mirarlas)

- **Cookies de sesión**: `brokaza_session` y `brokaza_admin_session` tienen `httpOnly`, `sameSite` y `secure` bien configurados.
- **CORS**: no hay middleware de CORS montado — correcto, porque el monolito sirve frontend y API desde el mismo origen.
- **Enumeración de emails admin**: `POST /api/auth/request-magic-link` (admin) responde igual exista o no el email en la allowlist.
- **Secreto de webhook interno**: comparado con `timingSafeEqual`, no vulnerable a timing attack.
- **Inyección en queries**: `zonesService.ts` usa RPCs parametrizados y el query builder de Supabase en todos lados; el único valor interpolado directo (`blindMatching.ts:252-253`) son columnas `CHECK`-constrained (enums), nunca input libre de usuario.
- **Secretos en el cliente**: no se encontraron API keys ni claves service-role en `src/dashboard/*.js` ni `src/admin-dashboard/*.js`.
- **PII hacia proveedores de IA**: los prompts en `src/services/ai.ts` trabajan sobre texto de búsqueda/columnas de Excel, no se identificaron campos de email/teléfono siendo enviados a OpenAI/Gemini.
- **Caché de zonas**: `zonesService.ts:121-154` ya cachea keywords de zonas en memoria con TTL — no hay hit a la base por request para datos de referencia.
- **Timeouts salientes**: las llamadas a Supabase Auth en rutas de auth ya usan un wrapper `withTimeout` (`src/index.ts:205,247,284,312`).
- **Dependencias**: `pnpm-lock.yaml` committeado, sin paquetes obviamente deprecados en `package.json`.
- **Tests**: 39 archivos bajo `tests/`, cobertura razonable de parseo de Excel, matcher, rate limiting, notificaciones, zonas — corridos con un runner propio (`tests/runner.ts`), no un framework estándar; funciona pero no paraleliza.

---

## ✅ Resuelto en esta ronda (KAN-128, KAN-129 — 2026-08-15)

| # | Ítem | Evidencia del fix |
|---|---|---|
| 1 | Polling del dashboard cada 2s | `src/dashboard/realtimeMatches.js` (`FALLBACK_POLL_MIN_MS`/`MAX_MS` = 15000/30000, jitter random) + `src/dashboard/app.js` (los 4 intervalos usan el rango, WS como señal primaria) + heartbeat ping/pong en `realtimeHub.ts`. Validado con load test real (50 y 268-300 conexiones concurrentes, 0 errores). |
| 2 | `error.message` filtrado al cliente en 12 rutas | Las 12 rutas de `src/index.ts` ya solo devuelven el fallback genérico; el `logger.error`/`console.error` sigue logueando el mensaje real. 12 tests de regresión en `tests/errorMessageLeak.test.ts`. |

## Clasificación de lo que queda (#3 a #25)

Cada ítem de arriba tiene ahora una línea **Clasificación** con el detalle. Resumen agrupado:

**🔧 Solo código (ticket de dev directo, sin bloqueos externos):** #6, #8, #11, #12, #13, #15, #19, #20, #21, #23, #24.

**🔀 Código + algo más (no se cierra solo editando el repo):**
- Código + Supabase (migración SQL/RPC): #4, #9.
- Código + decisión de producto/equipo: #5.
- Código + infraestructura (Railway, Redis, CDN): #7, #18, #22.
- Código + servicio externo a contratar: #14.
- Código de config + GitHub branch protection: #10.
- Código ya resuelto + ejecución operativa fuera del repo: #16.

**📄 100% fuera de código:** #3 (Supabase Vault), #17 (documentación, no lógica).

**👁️ Sin acción ahora, solo vigilancia:** #25.

## Resumen para arrancar — camino a 500-1000 usuarios

Con #1 y #2 ya resueltos, si tuvieras que elegir por dónde seguir hoy mismo:

1. **#3 (verificar `APP_URL` en Vault)** — cero código, 5 minutos en la consola de Supabase, cierra un riesgo operacional real antes de recibir tráfico. Agregalo ya a la checklist de deploy.
2. **#10 (CI)** — barato, y evita que cualquier regresión de #1/#2 (o de lo que sigue) se cuele sin que nadie la note a medida que el equipo crece.
3. **#6 (rate limit en admin) y #8 (segmentos en paralelo)** — 100% código, autocontenidos, listos para ser tickets de `/dev-backend` hoy mismo.
4. **#16 (correr el load test real)** — el código ya está (`scripts/load-test-dashboard.ts`); falta la ejecución contra staging desde una máquina separada para confirmar el número literal de 500-1000.
5. **#7 (WS hub por-proceso) y la infraestructura que dependa de escalar horizontalmente** — resolver en el mismo momento en que se decida correr 2+ instancias, no antes.
6. **#4, #5, #9** — mejoras de robustez del panel admin y del camino de búsqueda; #4 y #9 necesitan una migración SQL, #5 necesita primero que definan los roles.
7. **#14, #18, #22** — quedan esperando una decisión externa (proveedor de tiles, CDN, config de Railway) antes de poder convertirse en tickets de código.
8. El resto (#11, #12, #13, #15, #17, #19, #20, #21, #23, #24) son mejoras de calidad/mantenibilidad 100% código, para ir tomando en paralelo sin bloquear nada — #25 no requiere acción, solo vigilancia en code review.
