# Auditoría pre-producción — Brokaza

Fecha: 2026-08-14. Alcance: `src/` completo (backend Express, dashboard tenant, panel admin nuevo, servicios de matching/zonas), configuración de entorno y dependencias. No incluye `src/graph/*` (tooling interno de desarrollo, fuera del producto).

Cada ítem tiene: **qué es el riesgo**, **por qué importa**, **dónde está** (archivo:línea) y **cómo mitigarlo**. Priorizado para que puedas resolver de arriba hacia abajo antes de salir a producción.

---

## 🔴 CRÍTICO — bloqueante antes de producción

### 1. La app arranca igual aunque falten las credenciales de Supabase
`src/config/env.ts:10-11` declara `supabaseUrl` y `supabaseServiceRoleKey` como **opcionales**, y `src/services/supabase.ts:6-12` solo emite un `console.warn` si faltan — el cliente se crea igual con strings vacíos. La app arranca "sana" y **todas** las queries a la base fallan recién en el primer request real, con errores de bajo nivel del cliente HTTP en vez de un mensaje claro al desplegar.

**Riesgo:** un despliegue con variable de entorno mal copiada/faltante pasa el health check y sale a producción rota, en vez de fallar el arranque (fail-fast).

**Fix:** mover `supabaseUrl` y `supabaseServiceRoleKey` a la sección de variables requeridas de `validateConfig()` (igual que ya hace con `supabaseJwtSecret`/`supabaseAnonKey`), lanzando `Error` si faltan.

### 2. Rate limiters y cachés de sesión son 100% en memoria de proceso
`src/utils/rateLimit.ts`, el `sessionCache`/`authRateLimitMap` de `src/index.ts:147-185`, y el `adminSessionCache`/`adminAuthRateLimiter` de `src/adminAuth.ts` y `src/adminRoutes.ts:24` viven en un `Map` del proceso Node. El propio comentario en `rateLimit.ts:14-19` documenta la decisión: *"válido mientras la app corra como un único proceso"*.

**Riesgo real hoy:** ninguno si el deploy es realmente 1 instancia. **Riesgo al escalar:** en cuanto haya 2+ instancias detrás de un load balancer (lo primero que se hace para manejar más tráfico), cada instancia lleva su propio contador → el rate limit de auth (5/min), de `/api/search` (10/min) y de `/api/upload` (5/min) se multiplica silenciosamente por el número de instancias, sin ningún error visible. Es una regresión de seguridad silenciosa el día que escales horizontalmente.

**Fix (antes de agregar una segunda instancia, no necesariamente antes del primer deploy):** mover los limiters a Redis/Upstash (o a una tabla de Postgres con `UPSERT ... ON CONFLICT`) usando la misma interfaz `RateLimiter` que ya existe — el cambio queda contenido a `createRateLimiter()`.

### 3. Fuga de memoria en la caché de clientes Supabase por tenant
`src/services/supabase.ts:38,44-66` — `tenantClientsCache` es un `Map<token, SupabaseClient>` que **nunca se purga**. El comentario dice literalmente *"para evitar fugas de memoria"*, pero hace lo contrario: cada token de sesión que pasó alguna vez por `getTenantClient()` queda en memoria para siempre, incluso después de expirar (7 días) o de que el usuario cierre sesión. Con tráfico real y logins repetidos, esto crece sin límite hasta que el proceso se reinicia (o hasta OOM).

**Fix:** usar un TTL (mismo patrón que `sessionCache` en `index.ts`, con `expiresAt` y limpieza en `get`), o cambiar la clave a `tenantId` en vez de `token` (un cliente por tenant, no uno por token emitido), o correr una limpieza periódica (`setInterval`) que borre entradas vencidas.

### 4. `NODE_ENV` no se fuerza en producción → posible fuga de stack traces
No hay ningún middleware de manejo de errores global (`app.use((err, req, res, next) => ...)`) en `src/index.ts` ni en `src/adminRoutes.ts`, y `package.json:7` (`"start": "node -r ./instrument.js dist/index.js"`) no setea `NODE_ENV=production`. Si esa variable no está seteada en el entorno de despliegue, el manejador de errores por defecto de Express incluye el stack trace en la respuesta HTTP ante cualquier excepción no capturada dentro de una ruta.

**Fix:**
- Confirmar en Railway (u origen del deploy) que `NODE_ENV=production` esté seteado explícitamente, no asumido.
- Agregar un error handler global al final de `src/index.ts` que loguee con `logger.error` y devuelva siempre un JSON genérico (`{ error: 'Error interno' }`), sin importar el entorno — no depender de que `NODE_ENV` esté bien seteado como única defensa.

---

## 🟠 ALTO — resolver antes o muy cerca del lanzamiento

### 5. `xlsx` (SheetJS) — dependencia con vulnerabilidades conocidas sin parche en npm
`package.json:35` usa `"xlsx": "^0.18.5"`, instalada desde el registro público de npm. Esa línea de paquete tiene advisories conocidos (prototype pollution / ReDoS) que SheetJS **no volvió a parchear en npm** — las versiones corregidas solo se publican en su propio CDN, no en el registry de npm. `POST /api/upload` (`src/index.ts:439`) alimenta esta librería directamente con el archivo subido por el usuario.

**Fix:** migrar a la distribución oficial parcheada de SheetJS (`https://cdn.sheetjs.com/...`) según su guía de instalación, o evaluar `exceljs` como alternativa mantenida en npm.

### 6. Sentry captura bodies HTTP completos por default
`instrument.js` inicializa Sentry sin desactivar `httpBodies`/`userInfo` (las líneas están comentadas, no activas). Eso significa que cualquier excepción no capturada en una ruta que reciba `email`, `access_token`, o datos de perfil en el body puede terminar en Sentry en texto plano.

**Fix:** activar las líneas comentadas en `instrument.js` (`httpBodies: []`, o al menos excluir rutas de auth) antes de recibir tráfico real. Revisar también que Sentry no capture el `access_token` en headers (`Authorization`/cookies).

### 7. Patrón N+1 en `GET /api/properties` del panel admin
`src/adminRoutes.ts:214-233` — por cada una de las hasta 50 propiedades de una página, se llama `resolvePropertyZoneInfo()` (`src/services/zonesService.ts:264`), que a su vez dispara **hasta 2 round-trips a Postgres por propiedad** (un RPC espacial `neighborhood_for_point` + una resolución de texto). Una sola carga de página puede disparar ~100 llamadas a Supabase en paralelo.

**Riesgo:** funciona bien con pocos usuarios admin y catálogos chicos; con más propiedades y más operadores admin concurrentes, esto es el primer cuello de botella de latencia/costo (egress de Supabase) del panel admin.

**Fix:** batchear — crear un RPC en Postgres que reciba un array de `(lat, lon)` y devuelva todas las zonas en una sola llamada (`unnest()` + join espacial), o precalcular/cachear `zone_id` en la tabla `properties` y solo recalcular bajo demanda (botón "recalcular zona") en vez de en cada listado.

### 8. El panel admin usa siempre la clave service-role, sin autorización granular
Todas las rutas de `src/adminRoutes.ts` (métricas, listado de propiedades, edición de coordenadas) usan el cliente `supabase` con **service-role**, que ignora RLS por completo. Cualquier cuenta en `admin_users` tiene acceso total de lectura/escritura a datos de **todos** los tenants, sin distinción de roles (soporte vs. superadmin) ni límite de alcance. Solo la corrección de coordenadas queda auditada (`admin_audit_log`); las lecturas de métricas y listado de propiedades no dejan rastro de quién miró qué.

**Riesgo:** aceptable para una allowlist pequeña y de confianza (que es el modelo actual), pero es la superficie de mayor blast radius de todo el sistema — un solo `admin_users` comprometido = acceso total a datos de todos los tenants sin fricción.

**Fix (progresivo, no bloqueante para un lanzamiento con equipo chico):** loguear también los accesos de lectura a `/api/metrics` y `/api/properties` en `admin_audit_log` (o un log dedicado), y planear roles diferenciados (solo-lectura vs. edición) antes de sumar operadores admin adicionales.

### 9. Falta rate limiting en endpoints admin autenticados
`GET /api/metrics`, `GET /api/properties` y `PATCH /api/properties/:id/coordinates` (`src/adminRoutes.ts:158-309`) no tienen ningún rate limiter — solo el login (`adminAuthRateLimiter`, 5/min) lo tiene. Una cuenta admin comprometida (o un token de sesión admin filtrado) puede hacer scraping masivo del catálogo completo de todos los tenants sin fricción.

**Fix:** aplicar el mismo `createRateLimiter` (por `adminUserId`, no por IP) a las rutas autenticadas del panel admin.

---

## 🟡 MEDIO — importante, no bloqueante

### 10. Falta validación de tamaño/whitelist en el body JSON global
`express.json()` (`src/index.ts:84`, `src/adminRoutes.ts:46`) se usa sin límite explícito de tamaño (`{ limit: ... }`). El default de Express es 100kb, que probablemente esté bien para los payloads actuales, pero no está declarado explícitamente — si en el futuro se agrega un campo más pesado, el límite cambia sin que nadie lo decida a propósito.

**Fix:** declarar `express.json({ limit: '256kb' })` (o el valor que corresponda) explícitamente, para que quede documentado y no dependa del default de la librería.

### 11. PII en logs de texto plano sin redacción
`logger.ts` no usa la opción `redact` de Pino. Múltiples rutas loguean `email` en texto plano (`src/index.ts:263,266,270,...`) y el número de teléfono/nombre de perfil circula por logs de error (`err.message`) en varios puntos. No es grave por sí solo, pero combinado con el punto 6 (Sentry) y con que los logs probablemente terminen en un servicio externo (Railway logs / Sentry breadcrumbs), es superficie de exposición de PII innecesaria.

**Fix:** usar `redact: ['email', '*.email']` en la config de Pino, o loguear un hash/prefijo del email en vez del valor completo en los logs de nivel `warn`/`info` de alto volumen (ej. cada request a `/api/auth/request-magic-link`).

### 12. Atributo `title` sin escapar en el panel admin (inyección de atributo HTML)
`src/admin-dashboard/app.js:146` construye `title="Punto: ${property.zone.name} | Texto sugiere: ${property.textSuggestedZone.name}"` sin pasar `zone.name`/`textSuggestedZone.name` por `escapeHtml()` (a diferencia del resto del archivo, que sí escapa `address`). Si algún nombre de zona en la tabla `neighborhoods` alguna vez contiene una comilla doble, rompe el atributo y permite inyectar HTML/atributos arbitrarios dentro de la fila de la tabla.

**Riesgo bajo hoy** (los nombres de zona son datos de referencia cargados por el equipo, no input de usuario final), pero es inconsistente con el resto del archivo y es gratis de arreglar.

**Fix:** pasar ambos valores por `escapeHtml()` igual que `address`.

### 13. CSP permite tiles de OpenStreetMap sin límite de uso — no hay proxy/caché propio
`src/index.ts:79` agrega `https://*.tile.openstreetmap.org` a `img-src` para el mapa de Leaflet del panel admin. OSM tiene una [política de uso aceptable](https://operations.osmfoundation.org/policies/tiles/) estricta para tráfico de producción (no está pensada para apps comerciales con volumen) y puede bloquear el user-agent si se abusa.

**Fix:** no es urgente con pocos operadores admin, pero antes de un uso más intensivo del mapa conviene migrar a un proveedor de tiles con SLA (Mapbox, MapTiler, o self-hosted) en vez de depender del servicio gratuito de OSM.

### 14. Excel de subida se procesa de forma síncrona en el event loop
`processExcelBufferWithColumnMap` (invocado en `src/index.ts:507,594`) parsea el archivo completo en memoria, de forma síncrona, dentro del handler de la request. Con el límite actual de 10MB (`config.uploadMaxFileSizeBytes`) esto puede bloquear el event loop varios cientos de ms a segundos en archivos grandes con muchas filas/fórmulas, afectando la latencia de **todos los demás requests concurrentes** (Node es single-threaded).

**Fix:** no es necesario un rediseño completo antes del lanzamiento (el rate limit de 5 uploads/min ya acota el peor caso), pero si el catálogo promedio crece, mover el parseo a un worker thread (`worker_threads`) o a un job en background evita que una subida grande degrade el dashboard de otros tenants en simultáneo.

### 15. Sin índice de test de carga / sin métricas de latencia en producción
No hay ningún test de carga (`k6`, `autocannon`, etc.) en el repo, ni métricas de latencia expuestas (solo Sentry para errores, no APM de performance). Antes de anunciar el lanzamiento conviene tener al menos una corrida de carga básica sobre `/api/search` (el endpoint más caro: hace 1-2 llamadas a IA + varias queries) para confirmar cuántos tenants concurrentes soporta la instancia actual.

---

## 🟢 BAJO — mejoras, no bloqueantes

### 16. Falta límite superior de paginación en `GET /api/matches` y `/api/matches/incoming`
Ambos (`src/index.ts:1017-1064`) usan `.limit(50)` fijo, sin paginación real (`page`/`cursor`). Con historial largo, el tenant nunca ve matches viejos y no hay forma de pedir "la página siguiente". No es un problema de seguridad/rendimiento hoy, pero es deuda de producto que conviene resolver junto con cualquier trabajo futuro sobre estos endpoints.

### 17. `console.log`/`console.error` mezclados con el logger estructurado (Pino)
Varios puntos (`src/index.ts:524,613,1121`, `main()` en `src/index.ts:1173-1199`) usan `console.log`/`console.error` en vez de `logger`. Funciona, pero rompe el formato estructurado (JSON) del resto de los logs, dificultando búsquedas/alertas en el agregador de logs.

### 18. No hay chequeo de salud (`/health` o `/status`) dedicado
No se encontró un endpoint de healthcheck simple (sin autenticación, sin dependencias externas) para que la plataforma de hosting (Railway) verifique que el proceso está vivo, más allá de golpear `/`. Un `/health` liviano que no dependa de Supabase permite distinguir "el proceso está caído" de "Supabase está caído", crítico para debugging en incidentes.

---

## Resumen para arrancar

Si tuvieras que elegir por dónde empezar hoy mismo, en este orden:

1. **#1** (fail-fast en config) y **#3** (memory leak de `tenantClientsCache`) — son cambios chicos, aislados, y evitan las dos formas más tontas de romper producción sin darse cuenta.
2. **#4** (confirmar `NODE_ENV=production` + error handler global) — 30 minutos de trabajo, cierra la fuga de stack traces.
3. **#5** (migrar `xlsx`) y **#6** (Sentry sin bodies) — dependencias externas con exposición real, conviene resolverlas antes de tener usuarios reales subiendo archivos.
4. **#2** (rate limiters distribuidos) — no es urgente si el lanzamiento es con una sola instancia, pero es lo primero que hay que resolver el día que agregues una segunda para manejar más carga.
5. El resto (#7 en adelante) son mejoras de robustez que podés ir tomando en paralelo sin que bloqueen la salida a producción.
