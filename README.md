# Evolución del Proyecto HouseMatch

Este directorio contiene la trazabilidad de las decisiones de arquitectura, diseño de agentes y especificaciones de características a medida que evolucionamos de un MVP lineal hacia un sistema multi-agente modular y escalable.

## Índice de Especificaciones (ADR)

*   [spec_0001_mvp_base.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0001_mvp_base.md): Estado inicial del MVP, arquitectura base lineal, integraciones existentes y límites del sistema.
*   [spec_0002_definicion_coordinador.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0002_definicion_coordinador.md): Definición del rol, responsabilidades e interfaz técnica del Agente Coordinador (Orquestador).
*   [spec_0003_persistencia_y_validador.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0003_persistencia_y_validador.md): Persistencia con PostgreSQL (Prisma) y Agente Validador de Matches.
*   [spec_0004_migracion_supabase_sdk.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0004_migracion_supabase_sdk.md): Migración de Prisma a Supabase JS SDK.
*   [spec_0005_robustez_e_idempotencia.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0005_robustez_e_idempotencia.md): Idempotencia de mensajes de WhatsApp y sincronización de cartera por Upsert atómico.
*   [spec_0006_cola_y_base_de_datos.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0006_cola_y_base_de_datos.md): Sistema de colas y rate limiter para Gemini, y establecimiento de Supabase como única fuente de verdad.
*   [spec_0007_curacion_de_matches.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0007_curacion_de_matches.md): Curación de matches sugeridos desde el dashboard y registro de feedback para entrenamiento.
*   [spec_0008_multi_tenant_y_securizacion.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0008_multi_tenant_y_securizacion.md): Evolución a arquitectura multi-tenant (máx 10), seguridad contra inyección de prompts mediante XML wrappers, y servicio de notificaciones consolidadas rotativas (anti-baneo).

## Estado del Arte Actual
- **Agente Coordinador**: Definido (Orquestador principal con cola asíncrona, rate limiting, logs JSON, control de idempotencia multi-tenant y feedback de curación).
- **Sub-Agentes**:
  - [extractor.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/extractor.md) (Agente 1: Extractor de Entidades con blindaje de prompts XML).
  - [geolocator.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/geolocator.md) (Agente 2: Geolocalizador y Normalizador de Zona).
  - [validador.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/validador.md) (Agente 3: Validador cualitativo securizado).
  - [version_manager.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/version_manager.md) (Agente Gestor de Versiones y Ramas).
- **Notificador Consolidado**: Bucle en segundo plano asíncrono que consolida y rota plantillas de mensajes cada 10 minutos por tenant para mitigar baneo de WhatsApp.
- **Bases de Datos**: PostgreSQL en Supabase gestionado vía REST SDK como única fuente de verdad con arquitectura multi-tenant aislada por IP de cliente ("Zero-Login OTP IP-Binding" de 12 horas).
- **Orquestación:** Multi-tenant automatizado en NodeJS administrado por `src/services/coordinator.ts`.
- **Ecosistema de Agentes de Desarrollo Local:** Configurado en la ruta `.agent/skills/` con roles asignados para `@product`, `@pm`, `@backend`, `@frontend`, `@qa` y `@git`.
- **Registro Estructurado:** El historial detallado de estados de cada tarea e hito se encuentra disponible de forma síncrona en el archivo `.agent/evolution_log.json` para facilitar la lectura e indexación rápida de los agentes.

## Configuración de Variables de Entorno

El servidor **no arranca** si faltan variables de entorno requeridas (ver `src/config/env.ts#validateConfig`). Copiá `.env.example` a `.env` y completá los valores antes de correr el proyecto localmente.

Variables requeridas (sin default, el arranque falla si faltan):
- `GEMINI_API_KEY`
- `SUPABASE_JWT_SECRET`
- `SUPABASE_ANON_KEY`
- `INTERNAL_WEBHOOK_SECRET`
- `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`: claves del protocolo Web Push usadas para las notificaciones push del dashboard (`src/services/webPush.ts`). Generalas con:
  ```
  npx web-push generate-vapid-keys
  ```
  **No hay valores por default hardcodeados en el código** (KAN-81) — son secretos propios de cada entorno y deben configurarse explícitamente. En Railway (producción/staging) ya están seteadas en las variables de entorno del servicio; en local, agregalas a tu `.env`.

El resto de las variables documentadas en `.env.example` son opcionales y tienen defaults razonables definidos en `src/config/env.ts`.

## Formulario de Perfil de Tenant (KAN-90)

Tras el primer login por magic link, el agente completa un formulario obligatorio (`POST /api/profile`, validado en `src/utils/profileValidation.ts`) antes de poder usar el dashboard. Reglas de formato:

| Campo | Requerido | Reglas |
|---|---|---|
| Nombre (`first_name`) | Sí | 2–100 caracteres. Solo letras (con acentos/ñ), espacios, guiones y apóstrofes — ej. "María José", "O'Connor". Sin dígitos ni otros símbolos. |
| Apellido (`last_name`) | Sí | Mismas reglas que Nombre — ej. "Pérez-García". |
| Teléfono (`phone_number`) | Sí | Máximo 20 caracteres. Solo dígitos, espacios y los símbolos `+`, `-`, `(`, `)`. |
| Inmobiliaria (`agency_name`) | Sí | Máximo 150 caracteres, sin restricción de charset. |
| Ciudad (`city`) | Sí | Máximo 150 caracteres, sin restricción de charset. |
| País (`country`) | Sí | Máximo 150 caracteres, sin restricción de charset. |

`first_name`/`last_name` no tienen columnas propias en `profiles` — se combinan en el campo existente `full_name` (`profiles.full_name`) al persistir, sin necesidad de una migración de schema. `full_name` **ya no se autocompleta con el email truncado** (bug corregido en KAN-90, ver `POST /api/auth/exchange-token`): arranca vacío hasta que el agente completa el formulario.