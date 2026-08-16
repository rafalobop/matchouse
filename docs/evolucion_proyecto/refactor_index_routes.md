# KAN-142: Refactorización del monolito `src/index.ts`

## Qué cambió

`src/index.ts` pasó de ~1320 líneas (bootstrap de Express + las 19 rutas de la app de tenants) a
ser solo el bootstrap: seguridad HTTP (Helmet, CSP nonce, body size limit), archivos estáticos del
dashboard, gate de acceso privado, montaje de routers, y `main()` (arranque de los servicios de
fondo + `server.listen`).

Las 19 rutas quedaron repartidas en `src/routes/*.ts`, agrupadas por dominio, cada una un
`express.Router()` independiente montado en `src/index.ts` con `app.use(router)`:

| Módulo | Rutas | Responsabilidad única |
|---|---|---|
| `src/routes/auth.ts` | `GET /api/auth/session`, `POST /api/auth/request-magic-link`, `POST /api/auth/exchange-token`, `POST /api/auth/logout` | Ciclo de vida de la sesión (magic link de Supabase Auth, SPEC-0013) |
| `src/routes/profile.ts` | `GET /api/localities/tucuman`, `GET /api/profile`, `POST /api/profile` | Perfil del tenant (KAN-64) |
| `src/routes/upload.ts` | `POST /api/upload`, `POST /api/upload/confirm-mapping`, `GET /api/catalog` | Carga de cartera vía Excel |
| `src/routes/search.ts` | `POST /api/search`, `GET /api/searches`, `DELETE /api/searches/:id`, `POST /api/searches/:id/reactivate` | Matching ciego (búsqueda en texto libre) |
| `src/routes/matches.ts` | `GET /api/matches`, `GET /api/matches/incoming`, `POST /api/matches/:id/feedback` | Lectura y curación de `blind_matches` ya persistidos |
| `src/routes/notifications.ts` | `GET /api/notifications/vapid-public-key`, `POST /api/notifications/subscribe` | Suscripción Web Push del navegador |
| `src/routes/system.ts` | `GET /api/system/config-status`, `POST /api/dashboard-metrics`, `POST /internal/property-match-check` | Infraestructura/observabilidad + webhook interno de Postgres |

`src/adminRoutes.ts` (panel admin, `app.admin.brokaza.com`) queda tal cual estaba — es una rama
completamente aislada del pipeline de tenants desde antes de este ticket, con su propio patrón de
router montado en `mountAdminRouter(app)`; no se tocó.

`tenantAuthMiddleware` (la pieza de auth que consumen `profile`, `upload`, `search`, `matches`,
`notifications` y `dashboard-metrics`) se extrajo a `src/middleware/tenantAuth.ts` — es la única
dependencia verdaderamente transversal entre dominios, así que vive en su propio módulo en vez de
duplicarse o quedar acoplada a uno de los routers.

## Por qué esta agrupación (y no otra)

El ticket pedía explícitamente los dominios `auth`, `upload`, `matches`, `search`. Se agregaron
`profile`, `notifications` y `system` en vez de meter esas rutas dentro de uno de los cuatro
anteriores, porque cada una tiene una responsabilidad y un set de dependencias claramente distinto
(SOLID: Single Responsibility a nivel de módulo, no solo de función) — meter `POST
/internal/property-match-check` (auth por secreto compartido, sin sesión de tenant) dentro de
`matches.ts`, por ejemplo, le hubiera hecho perder cohesión al archivo sin ganar nada a cambio.

## Dependencias ocultas encontradas al separar

Estas son relaciones entre módulos que **no eran evidentes leyendo una sola ruta a la vez** dentro
del monolito, y que quedaron documentadas acá para que no se repita la arqueología la próxima vez
que alguien toque uno de estos archivos:

1. **`routes/search.ts` es el único productor de trabajo para `routes/matches.ts`.**
   `POST /api/search` (search.ts) es lo único que inserta filas en `blind_matches` — `matches.ts`
   solo lee y cura lo que `search.ts` ya escribió. No hay una dependencia de import directa entre
   ambos módulos, pero están acoplados a través de la tabla `blind_matches` y del shape que arma
   `src/utils/blindMatchPersistence.ts` (`buildBlindMatchInsertRows` en `search.ts`,
   `mapBlindMatchRowToDashboardShape`/`mapIncomingMatchRowToDashboardShape` en `matches.ts`) — un
   cambio de columnas en `blind_matches` obliga a revisar los dos archivos aunque parezcan no
   relacionados.

2. **`routes/search.ts` dispara notificaciones para tenants que no son el que hizo la request.**
   Cuando una búsqueda matchea, `processSingleSearchSegment` no solo notifica al tenant que buscó
   (`sendWebPushToTenant(tenantId, ...)`) — también notifica, en el mismo request, a cada
   `ownerTenantId` dueño de una propiedad matcheada (`groupMatchesByMatchedTenant`), vía
   `notifications.ts` (servicio) y `notifier-email.ts`. Un test o un mock que solo verifique la
   respuesta HTTP de `POST /api/search` para el tenant que llamó se pierde ese efecto secundario
   sobre *otros* tenants.

3. **`routes/upload.ts` y `services/propertyMatchWebhook.ts` (consumido por `routes/system.ts`)
   son las dos mitades del matching bidireccional**, pero no se llaman entre sí directamente: un
   trigger de Postgres (`property_uploaded_trigger`, fuera del código Node) es el que conecta un
   `INSERT` en `properties` (dentro de `syncPropertiesToDatabase`, llamado desde `upload.ts`) con
   `POST /internal/property-match-check` (`system.ts`) vía `pg_net`. Si se borra o renombra ese
   trigger en Supabase sin tocar ni una línea de TypeScript, la dirección cartera→búsqueda del
   matching deja de funcionar en silencio — ningún test de este repo lo detecta porque el trigger
   vive en la base, no en el código.

4. **`middleware/tenantAuth.ts` tiene su propia caché en memoria (`sessionCache`), separada de la
   caché de clientes Supabase (`tenantClientsCache` en `services/supabase.ts`).** Son dos TTLs
   independientes (30s vs. 30min) sobre el mismo token — un logout (`routes/auth.ts`) solo limpia
   la primera (`clearCachedSession`), la segunda expira sola. Esto ya era así en el monolito, pero
   quedaba menos visible por estar todo en el mismo archivo; separado en módulos, es más fácil
   pasarlo por alto si alguien intenta "arreglar" el logout para que invalide todo de una.

5. **`routes/upload.ts` es el único punto de la app que instancia `multer`.** Ningún otro router
   necesita parsing de multipart/form-data — quedó encapsulado ahí a propósito para que el resto
   de los dominios no cargue esa dependencia sin necesitarla.

6. **El rate limiter de `routes/auth.ts` (`limiterId: 'auth'`) es un namespace de Postgres
   compartido con `adminRoutes.ts`** en el sentido de que ambos usan `createDistributedRateLimiter`
   sobre la misma tabla `rate_limit_counters` — pero con `limiterId` distintos (`'auth'` vs.
   `'admin-auth'`), así que no colisionan entre sí a pesar de compartir infraestructura.

## Testing

No hay `supertest` en el repo (ver `tests/errorMessageLeak.test.ts` / `tests/health.test.ts`, que
ya documentaban esta ausencia antes de este ticket). En vez de agregar una dependencia nueva, se
sumó `tests/helpers/testServer.ts`: levanta un `express()` mínimo con un único router montado sobre
`http.createServer(...).listen(0)` (puerto efímero) y se le pega con `fetch` nativo (Node 18+).

Cada router nuevo tiene su `tests/routes/<dominio>.route.test.ts`, que verifica el contrato HTTP
real de las rutas protegidas por `tenantAuthMiddleware` (401 sin cookie de sesión, antes de tocar
Supabase) y de las rutas públicas/por secreto (`config-status`, webhook interno). No se mockea
Supabase para probar el camino "feliz" (autenticado) porque el SDK no es fácilmente inyectable sin
un framework de mocking que este repo no tiene — ese camino sigue cubierto, como antes del ticket,
por los tests de las funciones puras que cada ruta invoca (`searchValidation.test.ts`,
`profileValidation.test.ts`, `bodyWhitelist.test.ts`, `blindMatchPersistence.test.ts`,
`activeSearches.test.ts`, etc.).

`tests/searchSegmentsParallel.test.ts` y `tests/errorMessageLeak.test.ts` (regression tests que
leían `src/index.ts` como texto para verificar un patrón de código) se actualizaron para apuntar a
la nueva ubicación de cada ruta (`src/routes/search.ts`, y la concatenación de `src/index.ts` +
`src/routes/*.ts` respectivamente) en vez de perder cobertura silenciosamente.

Suite completa tras el refactor: **528/528 en verde**. `tsc --noEmit` y `npm run build` sin errores.
