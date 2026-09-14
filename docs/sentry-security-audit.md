# Auditoría periódica de la configuración de seguridad de Sentry (KAN-126)

Sentry captura errores no controlados de todo el proceso (ver `instrument.js` y el manejador de
errores global de `src/utils/errorHandler.ts`, KAN-124). La config de `dataCollection`
(`instrument.js` → `src/config/sentryDataCollection.ts`) evita que eso incluya credenciales reales
(`access_token`, secretos internos) — pero esa protección depende de que la lista de cookies/
headers sensibles en `sentryDataCollection.ts` se mantenga al día con lo que la app realmente usa.

**Cuándo repetir esta auditoría:** al agregar cualquier cookie, header o campo de body nuevo que
transporte una credencial o dato sensible (sesión, token, secreto compartido, contraseña), y como
mínimo una vez por trimestre calendario aunque no haya cambios conocidos.

## Checklist

1. **Cookies de sesión/acceso** — `grep -rn "res\.cookie(" src/` y confirmar que cada nombre de
   cookie encontrado está en `SENSITIVE_COOKIE_NAMES` (`src/config/sentryDataCollection.ts`).
2. **Headers con credenciales** — `grep -rn "Authorization\|x-internal-secret\|Bearer " src/` y
   confirmar que cualquier header nuevo que transporte una credencial está en
   `SENSITIVE_HEADER_NAMES`.
3. **`httpBodies` sigue en `[]`** — confirmar en `src/config/sentryDataCollection.ts` que
   `httpBodies` no se reactivó (ej. alguien lo cambió para debuggear localmente y lo dejó pisado).
4. **Verificación contra eventos reales** — entrar al proyecto de Sentry
   (`https://sentry.io/organizations/<org>/projects/`, DSN en `instrument.js`) y revisar los
   últimos 10-20 eventos capturados: confirmar que ningún campo `request.headers`,
   `request.cookies` o `request.data` contiene un `access_token`, `Bearer ...` o secreto en texto
   plano. Si aparece alguno, es señal de que `SENSITIVE_COOKIE_NAMES`/`SENSITIVE_HEADER_NAMES`
   quedaron desactualizadas respecto al código real — corregir y volver a este checklist.
5. **Tests siguen en verde** — `pnpm test` debe seguir pasando `tests/sentryDataCollection.test.ts`
   sin cambios; si se agregó una cookie/header nuevo al paso 1/2, agregar también un caso de test
   que lo cubra.

## Quién la corre

Responsabilidad del desarrollador que toca `src/index.ts`/`src/adminAuth.ts`/`src/adminRoutes.ts`
(donde viven las cookies/headers de auth) al mismo tiempo que hace ese cambio — no hace falta un
proceso separado con dueño fijo mientras el equipo sea chico. Si el equipo crece, este documento es
el punto de partida para convertirlo en un ticket recurrente.
