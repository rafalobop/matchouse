# Configuración de Resend para notificaciones por email

Paso a paso para dejar operativa la notificación de matches por email (`src/services/notifier-email.ts`).

## 1. Cuenta y API Key

1. Crear cuenta en [resend.com](https://resend.com).
2. Ir a **API Keys** → crear una key con permiso de envío (`Sending access`).
3. En este repo, la key se carga en la variable `SENDER_API_KEY` (nombre histórico ya usado en `.env` del proyecto — no confundir, es la key de Resend). Ver `.env.example`.

## 2. Remitente (`from`)

Por defecto el código usa `onboarding@resend.dev` (sandbox de Resend). Con este sender:
- **Solo se puede enviar a la casilla dueña de la cuenta de Resend.** Cualquier otro destinatario será rechazado por la API.
- Sirve para desarrollo/verificación, no para producción con múltiples tenants.

Para producción, verificar un dominio propio:
1. Dashboard de Resend → **Domains** → **Add Domain**.
2. Agregar los registros DNS (SPF/DKIM) que Resend indica, en el proveedor donde esté delegado el dominio.
3. Esperar verificación (puede tardar minutos a horas según el DNS).
4. Cambiar `FROM_ADDRESS` en `src/services/notifier-email.ts` a `HouseMatch <notificaciones@tu-dominio.com>`.

## 3. Variables de entorno

En `.env` (local) y en Railway (producción), configurar:

```
SENDER_API_KEY=re_xxxxxxxxxxxx        # API key de Resend
NOTIFICATION_CHANNEL=email            # email | whatsapp — email es la fuente primaria
NOTIFICATION_INTERVAL_MINUTES=20      # cada cuánto corre el cron de notificación
APP_URL=https://tu-app.railway.app    # usado para construir los links de pixel/click
```

## 4. Railway

En el servicio de Railway: **Variables** → agregar `SENDER_API_KEY`, confirmar que `NOTIFICATION_CHANNEL=email` y que `APP_URL` apunta al dominio público real (necesario para que los links de tracking del email funcionen).

## 5. Verificación manual

1. Con datos de prueba en `match_queue` (`is_notified=false`, `is_valid=true`, `score>=70`) para un tenant cuyo `profiles.email` sea una casilla real accesible.
2. Correr en dev: disparar manualmente `sendConsolidatedEmailNotifications()` (por ejemplo desde un script puntual o levantando el servidor con `NOTIFICATION_CHANNEL=email`).
3. Confirmar en el dashboard de Resend (**Emails** → **Sent**), vía `resend.emails.get(id)` (campo `last_event`), o en la casilla destino que el email llegó, con las propiedades y el botón de WhatsApp funcionando.

**Verificado en esta sesión (2026-07-02):** envío real disparado con datos de prueba, `resend.emails.get(id)` devolvió `last_event: "delivered"` (ruteado por Amazon SES), y el usuario confirmó haberlo recibido. **Cayó en la carpeta de Spam** — esperable al usar el dominio compartido `onboarding@resend.dev` sin reputación de envío propia. Para producción, verificar un dominio propio (sección 2) reduce mucho esto.

## Notas sobre el tracking

- El pixel de apertura y el link de click devuelven/redirigen igual aunque el registro en base falle (best-effort) — nunca deben romper la experiencia del destinatario del email.
- El pixel se embebe una sola vez por email (no uno por propiedad), asociado al primer match del lote — es una aproximación a nivel de envío, no de apertura por-propiedad.
