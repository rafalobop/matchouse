# Agentes en este repo

Antes de tocar código en `matchouse`, leé **[`.agent/CONTEXT.md`](.agent/CONTEXT.md)** — es la
memoria viva del proyecto: esquema real de Supabase, arquitectura del código, flujo de auth y
tracking de decisiones/correcciones de drift, con fechas. Se mantiene más al día que este README.

Los agentes del pipeline de matching (Coordinador, Extractor, Geolocator, Validador, Version
Manager) están definidos en `.agent/*.md`. Las "skills" de un equipo de desarrollo simulado
(backend_dev, frontend_dev, qa, tech_lead, etc.) están en `.agent/skills/` y `.claude/skills/`.

No leas de forma simultánea los specs históricos de `docs/evolucion_proyecto/` — el estado
consolidado vive en `.agent/CONTEXT.md`; esos specs son historial, no fuente de verdad actual.
