# Feature: Sistema de Colas (Rate Limiter) y Base de Datos Única (Spec 0006)

## Descripción
Esta feature incorpora una cola de procesamiento secuencial asíncrona para controlar la tasa de llamadas a las APIs de IA (evitando bloqueos de cuota) y establece Supabase como la única fuente de verdad, desacoplando los matches de Google Sheets.

## Objetivos
1. Crear una cola secuencial en memoria `AsyncMessageQueue` en `src/utils/queue.ts`.
2. Definir un intervalo de espera de 4.5 segundos entre mensajes para mantener el límite de llamadas a la API de Gemini por debajo del plan gratuito (15 RPM).
3. Eliminar la dependencia de Google Sheets para persistir los matches, delegando esa responsabilidad al 100% a la tabla `Match` de Supabase.
4. Cargar el catálogo al inicio del sistema directamente desde Supabase.
