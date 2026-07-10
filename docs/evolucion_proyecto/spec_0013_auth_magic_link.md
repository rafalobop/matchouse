# Especificación 0013: Auth Supabase Magic Link

Reemplaza el sistema de auth OTP por WhatsApp por un flujo de email magic link usando Supabase Auth.

---

## 1. Contexto y Motivación

El sistema anterior usaba un flujo de auth propio: el usuario ingresaba su número de teléfono de WhatsApp, el bot le enviaba un código OTP de 6 dígitos, y lo verificaba contra la tabla `profiles`. Este flujo tenía varios problemas:

- **Acoplamiento bot/auth:** Si el bot de WhatsApp caía, el acceso al dashboard se bloqueaba.
- **Sin estándar:** JWT generado manualmente con `SUPABASE_JWT_SECRET`, fuera del ecosistema de Supabase Auth.
- **Sin revocación:** Los tokens no podían invalidarse server-side.
- **Sin rate limiting:** Los endpoints de auth no tenían protección contra abuso.

Con la tabla `Tenant` renombrada a `profiles` en SPEC-0012 y los endpoints `/api/auth/*` stubbeados en 503, esta es la fase natural de reimplementación.

---

## 2. Decisiones de Diseño

### A. Supabase Auth + email magic link

`supabase.auth.signInWithOtp({ email })` envía un link de acceso al email del usuario. Al hacer clic, Supabase redirige a `APP_URL#access_token=TOKEN`. El frontend captura el token del hash de la URL y lo intercambia por una cookie HttpOnly server-side.

**Por qué magic link en lugar de email OTP (código de 6 dígitos):**
- UX más simple (un clic vs. copiar un código)
- Sin segundo paso de verificación manual
- Supabase maneja la expiración y revocación del token

### B. Cookie HttpOnly server-side

El access_token de Supabase se guarda como cookie `housematch_session` (HttpOnly, SameSite=Lax, Secure en producción). El frontend nunca accede al token directamente — la validación ocurre server-side en cada request protegido.

### C. `tenantAuthMiddleware` con `supabase.auth.getUser(token)`

Reemplaza el `jwt.verify()` manual. Llama a la API de Supabase Auth para validar el token y obtener `user.id` como `tenantId`. Ventaja: detecta tokens revocados (logout remoto).

### D. Upsert de perfil en primera sesión

`POST /api/auth/exchange-token` hace `supabase.from('profiles').upsert({ id: user.id }, { ignoreDuplicates: true })` para garantizar que existe un registro en `profiles` para el tenant antes de continuar.

### E. Rate limiting en memoria

Máximo 5 requests por minuto por IP en `POST /api/auth/request-magic-link`. Implementado como `Map<ip, { count, resetAt }>` sin dependencia externa.

---

## 3. Flujo de Autenticación

```
1. Usuario abre dashboard
   └─> handleMagicLinkCallback() — ¿hay #access_token en la URL?
       ├─ Sí → POST /api/auth/exchange-token → set cookie → checkAuthSession()
       └─ No → checkAuthSession() → ¿cookie válida?
           ├─ Sí → dashboard carga
           └─ No → mostrar auth overlay

2. Auth overlay — paso 1:
   Usuario ingresa email → POST /api/auth/request-magic-link
   → Supabase envía email con magic link → mostrar "Revisá tu email"

3. Usuario hace clic en el email
   → Supabase redirige a: APP_URL#access_token=TOKEN&token_type=bearer&...
   → handleMagicLinkCallback() captura TOKEN
   → POST /api/auth/exchange-token → cookie → dashboard

4. Logout:
   POST /api/auth/logout → clearCookie → auth overlay
```

---

## 4. Archivos Modificados

| Archivo | Cambio |
|---------|--------|
| `src/config/env.ts` | Agregar `appUrl` (lee `APP_URL`) |
| `src/index.ts` | Reemplazar middleware + 5 endpoints de auth |
| `src/dashboard/index.html` | Reemplazar auth overlay: email input + confirmación |
| `src/dashboard/app.js` | Reemplazar flujo OTP: magic link callback, handlers, limpiar refs obsoletas |
| `.env.example` | Actualizar con todas las variables requeridas |

---

## 5. Endpoints de Auth

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/auth/session` | Verifica cookie, retorna `{ authenticated, tenant: { id, email } }` |
| `POST` | `/api/auth/request-magic-link` | Envía email magic link (rate limit: 5/min/IP) |
| `POST` | `/api/auth/exchange-token` | Valida `access_token` del hash URL, setea cookie |
| `POST` | `/api/auth/logout` | Limpia cookie |

Endpoints eliminados: `request-otp`, `verify-otp`, `register-new`.

---

## 6. Estado de Implementación

- **Status:** Completado
- **Tests:** 15/15 en verde
- **Fecha de cierre:** 2026-07-01

---

## 7. Pendientes Post-SPEC-0013

- Configurar en Supabase Dashboard → Authentication → URL Configuration:
  - **Site URL:** `APP_URL` (ej. `https://tu-app.railway.app`)
  - **Redirect URLs:** agregar `APP_URL` a la lista de URLs permitidas
- Opcional: personalizar el template del email magic link en Supabase Dashboard → Authentication → Email Templates
- Rate limiting: considerar migrar a Redis si la carga aumenta (hoy es in-memory, se resetea al reiniciar)
