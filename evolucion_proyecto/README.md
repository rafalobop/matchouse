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
