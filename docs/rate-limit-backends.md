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
| Throughput | Sobra para la escala actual (10 tenants tope, límites de 5-10 req/min por tenant) — decenas de checks por minuto en el peor caso realista | Pensado para decenas de miles de ops/seg; no es un techo relevante ni a mucha más escala |
| Atomicidad | `UPSERT ... ON CONFLICT` (ver función `rate_limit_check`, migración `create_rate_limit_counters_table`) — Postgres serializa la fila entre transacciones concurrentes. Correcto, pero cada check es una transacción de escritura real | `INCR` + `EXPIRE` atómicos nativos — pensado exactamente para este caso de uso |
| Punto de falla adicional | Ninguno — si Postgres cae, la mayoría de las operaciones que el rate limiter protege (search, upload, auth) ya dependen de Postgres y fallarían igual | Uno más: un servicio extra que puede caerse independientemente del resto de la app |
| Costo | $0 adicional (ya pago por Supabase) | Free tier de Upstash cubre volúmenes bajos, pero es un límite/cuenta más para administrar |

## Decisión

**Postgres**, por estas razones concretas:

1. **Cero infraestructura nueva.** El proyecto no tiene Redis/Upstash provisionado hoy (confirmado
   en `.agent/CONTEXT.md` y en `src/config/env.ts` — no hay ninguna variable `REDIS_*`/`UPSTASH_*`).
   Agregar un servicio nuevo solo para esto, con la escala actual, es sumar superficie operativa sin
   necesidad real.
2. **La escala actual no necesita la latencia de Redis.** Con 10 tenants tope y límites de 5-10
   req/min, el volumen total de checks es de decenas por minuto en el peor caso. La diferencia entre
   ~50ms y ~3ms por check es imperceptible a ese volumen — el rate limiter no es un cuello de botella
   ni con Postgres.
3. **Un solo backend para todo.** El mismo cliente `supabase` (service-role) que ya usa el resto de
   la app para todo lo demás sirve para esto — no hay que aprender/mantener un cliente de Redis
   aparte, ni manejar sus propios reintentos/timeouts/fallos de conexión como un caso separado.
4. **Fail-open ante error, igual de simple con cualquiera de las dos opciones** — no es un
   diferenciador real entre Postgres y Redis, ambos requieren la misma decisión de diseño
   (`createDistributedRateLimiter` falla abierto, ver comentario en el código).

## Cuándo reconsiderar Redis/Upstash

- Si el volumen de tráfico crece varios órdenes de magnitud (ya no 10 tenants, sino cientos/miles) y
  el rate limiter empieza a competir de forma medible con el resto de las queries de la app por
  conexiones/capacidad de Postgres.
- Si aparece una necesidad de rate limiting sub-milisegundo real (ej. frente a un ataque de scraping
  agresivo donde cada check debe resolverse casi instantáneo para no degradar la experiencia del
  resto de los requests).
- Si el proyecto ya termina agregando Redis por otro motivo (ej. cache de sesión, colas) — en ese
  caso, reusar esa misma infraestructura para rate limiting sería la elección obvia, por el mismo
  criterio de "no dupliques infraestructura" que hoy favorece a Postgres.

## Verificación de carga realizada

Ver `src/test-rate-limit-distributed.ts` (script manual, no parte de `npm test` — corre contra la
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
