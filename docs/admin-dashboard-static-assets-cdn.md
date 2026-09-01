# Assets estáticos del panel admin: caché, CDN y monitoreo (KAN-289)

Este documento cubre las dos partes de KAN-289 que no son código: el análisis de si conviene un CDN
para `src/admin-dashboard` (servido por `express.static`, ver `src/adminRoutes.ts`), y el plan de
monitoreo post-implementación de la caché de 1 año + `immutable` agregada en el mismo ticket.

## Qué se implementó en código

- `express.static(adminDashboardPath, { maxAge: '1y', immutable: true })` — el browser deja de
  revalidar (`304`) estos assets en cada carga y los sirve directo de su caché local por un año.
- Versionado por contenido: `assetVersion()` calcula un hash corto (`sha256`, 8 hex) de cada asset
  referenciado desde `index.html` (`style.css`, `app.js`, `htmlSanitize.js`,
  `vendor/leaflet/leaflet.{css,js}`) al levantar el proceso, y lo inyecta como `?v=<hash>` en las
  referencias de `index.html`. `index.html` en sí no pasa por `express.static` — se sirve dinámico
  (para poder inyectar el nonce de CSP en cada request) y por lo tanto nunca queda cacheado de forma
  inmutable, así que siempre apunta a la versión vigente de cada asset.

## Análisis: ¿hace falta un CDN?

**No, no todavía.** Con la escala actual, un CDN dedicado (Cloudflare, CloudFront, Fastly) no
resuelve un problema real:

| Factor | Situación actual |
|---|---|
| Tamaño del bundle | `app.js` (~11 KB) + `style.css` (~6 KB) + `htmlSanitize.js` (~2 KB) + `leaflet.css`/`leaflet.js` vendorizados (~160 KB combinados, cacheados 1 año gracias a este ticket) — total bajo 200 KB, casi todo cacheable tras la primera carga |
| Usuarios del panel admin | Uso interno, no público — el equipo que opera Brokaza (`isAllowedAdminEmail`/`isAllowedAdminUser` en `src/adminAuth.ts`), no tenants ni usuarios finales. Tráfico de bajísimo volumen y concentrado geográficamente (Tucumán, Argentina), no una audiencia global que se beneficie de PoPs distribuidos |
| Latencia actual | Railway (hosting actual, ver `docs/RUNBOOK.md`) ya sirve con TLS y HTTP/2 desde su propia infraestructura — la latencia de red para un puñado de usuarios en una sola región no es un cuello de botella medido ni reportado |
| Costo/complejidad de agregar uno | Un dominio nuevo o proxy delante de `ADMIN_HOST`, invalidación de caché coordinada con deploys, una dependencia externa más que puede fallar independientemente del resto de la app (mismo argumento que descartó Redis/Upstash para rate limiting, ver `docs/rate-limit-backends.md`) |

**Qué lo justificaría más adelante:** si el panel admin pasara a tener usuarios fuera de Argentina
con latencia perceptible, o si el bundle creciera significativamente (por ejemplo, si se le agrega
un framework de frontend con un bundle de cientos de KB-varios MB). Ninguno de los dos es el caso
hoy. La combinación `maxAge: 1y` + `immutable` + versionado por contenido de este ticket ya captura
la mayor parte del beneficio de un CDN (assets servidos desde caché local del browser en cargas
repetidas) sin agregar infraestructura nueva.

## Plan de monitoreo post-implementación

**Qué mirar:** confirmar que los browsers efectivamente están cacheando los assets versionados (no
hay regresión de hit rate cuando se agrega o cambia un asset) y que el mecanismo de invalidación
(hash en la URL) funciona en la práctica tras un deploy.

**Cómo, con lo que el proyecto ya tiene** (sin agregar herramientas nuevas, mismo criterio que el
resto de KAN-289):

1. **DevTools / Network tab** (manual, primera verificación tras el deploy): recargar
   `https://<ADMIN_HOST>/` dos veces seguidas. En la segunda carga, `style.css`, `app.js`,
   `htmlSanitize.js` y `vendor/leaflet/*` deben aparecer servidos "from disk cache" / "from memory
   cache" (Chrome) en vez de disparar una request de red — confirma que `Cache-Control: max-age=…,
   immutable` está siendo respetado por el browser.
2. **Confirmar la invalidación real:** tras cualquier cambio a `app.js`/`style.css`/etc., el hash en
   `assetVersion()` cambia automáticamente (está atado al contenido del archivo) y por lo tanto la
   URL en `index.html` cambia — no hace falta ningún paso manual de "bump de versión". Verificar una
   vez por release (o cuando se toque un asset del panel admin) que el `?v=` en el HTML servido
   cambió respecto al deploy anterior, comparando el HTML de `/` antes/después.
3. **Logs existentes:** `src/adminRoutes.ts` ya loguea `[ADMIN] Panel admin montado` al arrancar
   (`logger.info`, ver también `docs/RUNBOOK.md` para el resto del pipeline de Sentry/alertas ya
   existente en el proyecto). No se agrega logging por-request de cache hits: `express.static` no
   expone esa métrica de forma nativa sin middleware adicional, y a este volumen de tráfico
   (uso interno, pocos usuarios) el costo de instrumentarlo no se justifica frente a la verificación
   manual del punto 1.
4. **Cuándo revisar de nuevo:** si en algún momento se sospecha que un cliente quedó sirviendo un
   asset viejo (bug reportado que "desaparece" al hacer hard-refresh), es señal de que el mecanismo
   de versionado no está cubriendo algún asset nuevo agregado a `index.html` sin pasar por
   `assetVersion()` — revisar que el array de assets versionados en `mountAdminRouter`
   (`src/adminRoutes.ts`) incluya cualquier archivo estático nuevo que se referencie desde ahí.

**Explícitamente fuera de alcance:** métricas cuantitativas de hit rate agregado (requeriría un CDN
o un servicio de RUM externo) — no se justifica agregar esa infraestructura para un panel de uso
interno con la escala actual, ver análisis de CDN arriba.
