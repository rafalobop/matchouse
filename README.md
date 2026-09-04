# Brokaza — Backend

API de Brokaza: matching ciego de propiedades entre inmobiliarias (Tucumán, Argentina). Cada tenant
(agente/inmobiliaria) carga su cartera de propiedades vía Excel y publica búsquedas en texto libre;
el backend extrae la intención con IA (Gemini, con fallback a OpenAI) y cruza esa búsqueda contra la
cartera de **otros** tenants (nunca la propia) — de ahí "ciego": ningún tenant ve el catálogo ajeno,
solo recibe avisos de matches puntuales.

Repo separado del frontend (`brokaza-frontend`, Next.js) desde KAN-145 — este repo expone solo API
(`/api/*`, `/internal/*`, `/health`, WebSocket en `/ws`) más el panel admin, que todavía sirve su
propio bundle estático (`src/admin-dashboard/`, en migración, ver `MIGRATION_PLAN.md`).

## Stack

- **Node.js + TypeScript** (Express 5, `strict: true` en `tsconfig.json`)
- **Supabase** (Postgres + Auth + Realtime vía WebSocket propio, no el de Supabase) como única base de datos, con RLS multi-tenant
- **Gemini** (primario) + **OpenAI** (fallback automático) para extracción de intención de búsqueda en texto libre
- **Resend** para el envío de emails (magic link de auth + notificaciones)
- **Web Push (VAPID)** para notificaciones push del dashboard
- Test runner nativo de Node (`node:test`), sin Jest ni supertest

## Arquitectura del código

```
src/
├── index.ts              # bootstrap del proceso: handlers de unhandledRejection/uncaughtException,
│                          # arranca servicios de fondo, crea el server HTTP y hace listen()
├── app.ts                # createApp(): Helmet/CSP, express.json, cookieParser, monta el panel
│                          # admin, GET /health, estáticos de public/, y el router de src/routes/
├── adminRoutes.ts         # router del panel admin (app.admin.brokaza.com) — cross-tenant, montado
│                          # aparte, solo si ADMIN_HOST está seteada
├── middleware/            # tenantAuthMiddleware (auth de tenant) y afines
├── routes/*Routes.ts      # un router por dominio: auth, profile, upload, catalog, search, matches,
│                          # notifications, internal — define paths/middleware (auth, rate limit)
├── controllers/*Controller.ts  # la lógica de request/response de cada router, en pares 1:1
├── services/               # lógica de negocio pura: ai.ts (extracción/IA), blindMatching.ts
│                          # (motor de matching), excel.ts (parseo de cartera), webPush.ts,
│                          # notifier-email.ts, realtimeHub.ts (WebSocket), searchExpiration.ts, etc.
├── config/env.ts          # validación fail-fast de variables de entorno al arrancar
├── utils/                 # helpers puros (rate limiting, validaciones, whitelist de body, etc.)
├── types/database.types.ts # tipos generados desde el schema real de Supabase (no se edita a mano)
└── admin-dashboard/        # bundle estático legacy del panel admin (en migración)
```

## Autenticación

**Tenants** (`src/routes/authRoutes.ts` + `src/controllers/authController.ts`): magic link vía
Supabase Auth. Flujo: el usuario pide un link (`POST /api/auth/request-magic-link`, rate-limited por
IP y por email) → lo recibe por email (Resend, no el mail default de Supabase) → al hacer clic,
el frontend intercambia el token (`POST /api/auth/exchange-token`) → cookie HttpOnly
`brokaza_session`. `tenantAuthMiddleware` valida esa cookie contra Supabase Auth en cada request
(con una caché en memoria de 30s para no pegarle a Supabase en cada request).

**Admin** (`src/adminRoutes.ts` + `src/adminAuth.ts`): mismo mecanismo de magic link, pero
completamente aislado — cookie, allowlist de emails y router propios, montado solo cuando la request
llega con `Host === ADMIN_HOST`. Nunca comparte sesión ni rutas con el flujo de tenant.

No hay OTP ni binding por IP — esa arquitectura (documentada en versiones viejas de este archivo) se
reemplazó por completo con el magic link de Supabase Auth.

## Multi-tenancy

Todas las tablas de negocio tienen `tenant_id` y RLS (`tenant_id = auth.uid()`). El patrón real
(KAN-63, "Tenant Context"): cada request autenticado de tenant recibe `req.supabaseClient`, un
cliente Supabase scoped al usuario real (anon key + su `access_token` como Bearer) — RLS se aplica
de verdad en cada query, no solo como defensa en profundidad teórica. Los procesos de fondo sin
sesión de usuario (crons, notificadores) usan el cliente service-role a propósito.

## Empezar local

```bash
npm install
cp .env.example .env   # completar los valores, ver sección de abajo
npm run dev            # ts-node, con reload manual (no hot-reload)
```

El servidor **no arranca** si faltan variables de entorno requeridas (`src/config/env.ts`, fail-fast
por diseño). Levanta en `http://localhost:3000` por default.

## Variables de entorno

Copiá `.env.example` a `.env`. Variables requeridas (sin default, el arranque falla si faltan):

- `GEMINI_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`
- `INTERNAL_WEBHOOK_SECRET` — secreto de `POST /internal/property-match-check`, llamado por un trigger de Postgres
- `SENDER_API_KEY` (Resend) — el magic link (login de tenant y admin) se manda por acá, sin esto nadie puede loguearse
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: claves del protocolo Web Push (`src/services/webPush.ts`). Generalas con:
  ```
  npx web-push generate-vapid-keys
  ```
  **No hay valores por default hardcodeados en el código** (KAN-81) — son secretos propios de cada entorno. En Railway (producción/staging) ya están seteadas; en local, agregalas a tu `.env`.

`ALLOW_MISSING_SUPABASE_CREDENTIALS=true` permite arrancar sin `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (solo para desarrollo local sin Supabase configurado todavía — **nunca en producción**; ojo que igual hace falta una `SUPABASE_URL` con formato válido para el cliente scoped a tenant, ver `getTenantClient`).

El resto de las variables documentadas en `.env.example` (rate limits, `ADMIN_HOST`, `APP_URL`, tamaños de pool de parseo de Excel, etc.) son opcionales y tienen defaults razonables en `src/config/env.ts`.

## Tests

```bash
npm test         # node:test vía tests/runner.ts — todos los archivos de tests/ en un solo proceso
npm run build     # tsc, sin emitir dist/ en dev (usalo para chequear tipos)
```

Sin harness de supertest/Express en este repo — los tests de rutas invocan los controllers
directamente con request/response fake, y todo lo externo (Supabase, Gemini/OpenAI, Resend, Web
Push) va mockeado con `t.mock.method`. Ningún test pega a red real.

## CI

`.github/workflows/ci.yml` (KAN-281): en cada PR/push a `master`/`development` corre
`npm ci && npm run build && npm test` sobre Node 22. Las variables de entorno que requiere
`config/env.ts` van como placeholders inline en el workflow (no hacen falta secrets reales, ningún
test pega a red) — única excepción, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` sí necesitan el formato
real de un par de claves EC porque `web-push` los valida al importar el módulo.

## Tipado de las respuestas de Supabase (KAN-139)

`src/services/supabase.ts` expone `supabase` (cliente service-role) y `getTenantClient(token)`
(cliente scoped al tenant) tipados como `TypedSupabaseClient` = `SupabaseClient<Database>`.
`Database` vive en `src/types/database.types.ts`, generado directamente desde el schema real del
proyecto de Supabase — **no se edita a mano**.

Implicancias para código nuevo:
- Cualquier `.from('tabla')` sobre `supabase` o `getTenantClient(...)` tipa `select`/`insert`/`update`/`delete`/`eq`/etc. contra las columnas reales — un typo o un tipo que no matchea es error de compilación, no un `any` silencioso.
- Si una función recibe un `SupabaseClient` inyectado como parámetro (patrón usado para poder testear sin red real), tipalo como `TypedSupabaseClient`.
- **Regenerar `database.types.ts` cada vez que cambie el schema real**: `mcp__supabase__generate_typescript_types`, o `supabase gen types typescript --project-id <project-id>` con la CLI.

## Formulario de perfil de tenant (KAN-90)

Tras el primer login por magic link, el agente completa un formulario obligatorio
(`POST /api/profile`, validado en `src/utils/profileValidation.ts`) antes de poder usar el
dashboard.

| Campo | Requerido | Reglas |
|---|---|---|
| Nombre (`first_name`) | Sí | 2–100 caracteres. Solo letras (con acentos/ñ), espacios, guiones y apóstrofes. |
| Apellido (`last_name`) | Sí | Mismas reglas que Nombre. |
| Teléfono (`phone_number`) | Sí | Máximo 20 caracteres. Solo dígitos, espacios y `+ - ( )`. |
| Inmobiliaria (`agency_name`) | Sí | Máximo 150 caracteres, sin restricción de charset. |
| Ciudad (`city`) | Sí | Máximo 150 caracteres — combobox de localidades reales de Tucumán (API Georef), con opción "Otra localidad...". |

`first_name`/`last_name` se combinan en `profiles.full_name` al persistir (no tienen columnas
propias). **País/Provincia fijos a Argentina/Tucumán** (KAN-93, decisión de negocio explícita): el
backend hardcodea `country = 'Argentina'` siempre, sin importar el payload.

## Otros documentos

- `MIGRATION_PLAN.md` — plan de migración del frontend legacy (`src/admin-dashboard`) a `brokaza-frontend` (Next.js), fases y prioridades.
- `docs/RUNBOOK.md` — observabilidad y alertas de errores en producción (healthcheck, Sentry).
- `docs/rate-limit-backends.md` — por qué el rate limiting distribuido usa Postgres y no Redis.
- `.agent/CONTEXT.md` — memoria viva del proyecto: arquitectura al detalle, historial de decisiones y tracking de tickets. Fuente de verdad más granular que este README.
