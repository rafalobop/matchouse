# Rate limiting distribuido: Postgres vs Redis/Upstash (KAN-127)

Este documento explica la decisión detrás de `createDistributedRateLimiter` (`src/utils/rateLimit.ts`):
por qué Postgres (Supabase, ya provisto) en vez de Redis/Upstash, y qué llevaría cambiar de opinión
más adelante.

## Contexto

`createRateLimiter` (en memoria, KAN-71) tiene un problema documentado: cada instancia del proceso
Node lleva su propio conteo. Detrás de un balanceador de carga con N instancias, el límite efectivo
se multiplica por N — un tenant puede hacer `N × límite` requests en la misma ventana repartiéndolas
entre instancias. Es válido mientras la app corra como un único proceso, pero deja de serlo en
cuanto se agrega una segunda instancia para manejar más tráfico.

## Comparación

| | Postgres (elegido) | Redis/Upstash |
|---|---|---|
| Infraestructura nueva | Ninguna — reusa el mismo proyecto Supabase que ya sostiene todo lo demás | Servicio nuevo a provisionar, monitorear y (eventualmente) pagar; nueva credencial en `.env` |
| Latencia por check | ~20-80ms (red hacia Supabase, mismo costo que cualquier query existente de la app) | ~1-5ms — diseñado específicamente para contadores efímeros de alta frecuencia |
| Throughput | Sobra para la escala actual (base de tenants chica, límites de 5-10 req/min por tenant) — decenas de checks por minuto en el peor caso realista | Pensado para decenas de miles de ops/seg; no es un techo relevante ni a mucha más escala |
| Atomicidad | `UPSERT ... ON CONFLICT` (ver función `rate_limit_check`, migración `create_rate_limit_counters_table`) — Postgres serializa la fila entre transacciones concurrentes. Correcto, pero cada check es una transacción de escritura real | `INCR` + `EXPIRE` atómicos nativos — pensado exactamente para este caso de uso |
| Punto de falla adicional | Ninguno — si Postgres cae, la mayoría de las operaciones que el rate limiter protege (search, upload, auth) ya dependen de Postgres y fallarían igual | Uno más: un servicio extra que puede caerse independientemente del resto de la app |
| Costo | $0 adicional (ya pago por Supabase) | Free tier de Upstash cubre volúmenes bajos, pero es un límite/cuenta más para administrar |

## Decisión

**Postgres**, por estas razones concretas:

1. **Cero infraestructura nueva.** El proyecto no tiene Redis/Upstash provisionado hoy (confirmado
   en `.agent/CONTEXT.md` y en `src/config/env.ts` — no hay ninguna variable `REDIS_*`/`UPSTASH_*`).
   Agregar un servicio nuevo solo para esto, con la escala actual, es sumar superficie operativa sin
   necesidad real.
2. **La escala actual no necesita la latencia de Redis.** Con la base de tenants actual (sin
   registro limitado, ver `.agent/CONTEXT.md#2` — no hay un tope duro de tenants como este documento
   asumía antes) y límites de 5-10 req/min por tenant, el volumen total de checks sigue siendo bajo.
   La diferencia entre ~50ms y ~3ms por check es imperceptible a ese volumen — el rate limiter no es
   un cuello de botella ni con Postgres, mientras el número de tenants no crezca varios órdenes de
   magnitud (ver sección de abajo).
3. **Un solo backend para todo.** El mismo cliente `supabase` (service-role) que ya usa el resto de
   la app para todo lo demás sirve para esto — no hay que aprender/mantener un cliente de Redis
   aparte, ni manejar sus propios reintentos/timeouts/fallos de conexión como un caso separado.
4. **Fail-open ante error, igual de simple con cualquiera de las dos opciones** — no es un
   diferenciador real entre Postgres y Redis, ambos requieren la misma decisión de diseño
   (`createDistributedRateLimiter` falla abierto, ver comentario en el código).

## Cuándo reconsiderar Redis/Upstash

- Si el volumen de tráfico crece varios órdenes de magnitud (cientos/miles de tenants, sin el tope
  que este documento asumía antes) y
  el rate limiter empieza a competir de forma medible con el resto de las queries de la app por
  conexiones/capacidad de Postgres.
- Si aparece una necesidad de rate limiting sub-milisegundo real (ej. frente a un ataque de scraping
  agresivo donde cada check debe resolverse casi instantáneo para no degradar la experiencia del
  resto de los requests).
- Si el proyecto ya termina agregando Redis por otro motivo (ej. cache de sesión, colas) — en ese
  caso, reusar esa misma infraestructura para rate limiting sería la elección obvia, por el mismo
  criterio de "no dupliques infraestructura" que hoy favorece a Postgres.

## Estado actual de la migración (revisado 2026-09-07, KAN-311)

`createDistributedRateLimiter` está en uso en `adminRoutes.ts` (`admin-auth`, `admin-metrics`,
`admin-api`) y, desde KAN-311, en `uploadRateLimiter` (`routes/uploadRoutes.ts`, limiterId
`'upload'`, mismo límite por `tenantId` que ya tenía — `config.uploadRateLimitMax`/
`uploadRateLimitWindowMs` — sin cambio de comportamiento observable para el usuario, solo de
dónde vive el contador). El resto de los limiters de la app —
`authIpRateLimiter`/`authEmailRateLimiter` (`routes/authRoutes.ts`), `searchRateLimiter`
(`routes/searchRoutes.ts`) y `dashboardMetricsRateLimiter` (`routes/systemRoutes.ts`) — siguen en
`createRateLimiter` (en memoria). Mientras la app corra como una única instancia Node esto es
correcto, pero si en algún momento se agrega un segundo proceso/instancia detrás de un balanceador
de carga (necesario para escalar horizontalmente a medida que crece la cantidad de tenants, ver
nota sobre el registro sin límite en `.agent/CONTEXT.md#2`), estos tres límites restantes dejan de
ser efectivos tal como se explica arriba. Migrarlos es mecánico (mismo patrón que ya usa
`adminRoutes.ts`/`uploadRoutes.ts`) pero no se hizo todavía — evaluarlo si/cuando se planee correr
más de una instancia.

**Rollback de la migración de `uploadRateLimiter` (KAN-311):** revertir el commit que cambió
`routes/uploadRoutes.ts` (import + instanciación de `uploadRateLimiter` + `checkUploadRateLimit`
vuelta a síncrona) restablece el rate limiter en memoria sin ningún otro cambio de código — no
hay migración de esquema que revertir (la tabla `rate_limit_counters` ya existía de KAN-127, no
se creó nada nuevo para este ticket) ni estado que migrar de un backend al otro (son contadores
efímeros de ventana corta, perder el conteo acumulado al hacer rollback no tiene impacto real).
Sin downtime: es un cambio de código puro, se aplica con un deploy normal.

**Gap de testing conocido (KAN-311):** `checkUploadRateLimit` ahora depende de
`createDistributedRateLimiter`, que usa por default el singleton service-role
(`services/supabase.ts`) sin seam de inyección para tests — mismo gap ya documentado en
`tests/helpers/fakeSession.ts` para otros controllers que importan ese singleton directo. Los
tests HTTP de `tests/routes/upload.route.test.ts` que llegan hasta `checkUploadRateLimit` (los
que sí tienen sesión válida) ahora hacen un round-trip real contra el RPC `rate_limit_check` del
proyecto Supabase configurado en `.env` (~250ms en vez de unos pocos ms) antes de resolver el 400
de "sin archivo" — fail-open si ese RPC falla, así que el resultado del test sigue siendo
determinístico, pero deja de ser 100% aislado de la red/DB real. No se agregó un seam de
inyección nuevo para esto: es el mismo trade-off que ya aceptan `adminRoutes.ts`
y sus limiters distribuidos, y resolverlo de raíz (inyección del cliente service-role en todos
los controllers que lo usan directo) es un cambio de mayor alcance, fuera de este ticket.

## Verificación de carga realizada

Ver `scripts/test-rate-limit-distributed.ts` (script manual, no parte de `npm test` — corre contra la
base real de Supabase). Simula 3 instancias del proceso Node completamente independientes (sin
ningún estado en memoria compartido entre ellas) pegándole a la misma tabla, con:

- **15 requests secuenciales** repartidas round-robin entre las 3 instancias, límite configurado en
  5 → resultado real: exactamente 5 permitidas.
- **15 requests concurrentes** (`Promise.all`, no un loop secuencial — el caso que expondría una
  condición de carrera si el `UPSERT` no fuera atómico) → resultado real: exactamente 5 permitidas,
  sin duplicados ni pérdidas de conteo.

Ambas corridas confirman que el límite es efectivamente compartido entre instancias (no se
multiplica por N como pasaba con `createRateLimiter` en memoria) y que no hay condiciones de carrera
bajo concurrencia real.
