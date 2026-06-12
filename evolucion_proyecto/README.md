# Evolución del Proyecto HouseMatch

Este directorio contiene la trazabilidad de las decisiones de arquitectura, diseño de agentes y especificaciones de características a medida que evolucionamos de un MVP lineal hacia un sistema multi-agente modular y escalable.

## Índice de Especificaciones (ADR)

*   [spec_0001_mvp_base.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/evolucion_proyecto/spec_0001_mvp_base.md): Estado inicial del MVP, arquitectura base lineal, integraciones existentes y límites del sistema.

## Estado del Arte Actual
- **Agente Coordinador**: Definido (Orquestador principal).
- **Sub-Agentes**:
  - [extractor.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/extractor.md) (Agente 1: Extractor de Entidades).
  - [geolocator.md](file:///c:/Users/NoxiePC/Desktop/Software/housematch/.agents/geolocator.md) (Agente 2: Geolocalizador y Normalizador de Zona).
- **Bases de Datos**: Catálogo local en caché (`catalog.json`) sincronizado con Google Sheets/Excel.
