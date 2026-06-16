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

## Estado del Arte Actual
- **Agente Coordinador**: Definido (Orquestador principal con cola asíncrona, rate limiting, logs JSON, control de idempotencia y feedback de curación).
- **Sub-Agentes**:
  - [extractor.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/extractor.md) (Agente 1: Extractor de Entidades).
  - [geolocator.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/geolocator.md) (Agente 2: Geolocalizador y Normalizador de Zona).
  - [version_manager.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/version_manager.md) (Agente Gestor de Versiones y Ramas).
- **Bases de Datos**: PostgreSQL en Supabase gestionado vía REST SDK como única fuente de verdad para propiedades y matches, con cola de peticiones y sincronización de catálogo optimizada.
