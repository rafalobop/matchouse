# Feature: Implementación del Agente Coordinador (Orquestador)

## Descripción
Esta feature consiste en desacoplar el flujo de procesamiento lineal actualmente presente en `src/index.ts` e implementar un **Agente Coordinador** modular en `src/services/coordinator.ts`.

## Objetivos
1. Crear la clase `CoordinatorAgent` y la estructura del `PipelineContext`.
2. Migrar la ejecución del Pre-Filtro, Agente 1 (Extractor) y Agente 2 (Geolocalizador) al flujo orquestado por el Coordinador.
3. Soportar logging enriquecido en consola para el ciclo de vida de cada pipeline.
4. Mantener la compatibilidad con el front-end del Dashboard y las notificaciones a WhatsApp existentes.

## Tareas
- [x] Definir los tipos de datos en `src/types/pipeline.ts` o directamente en el servicio.
- [x] Implementar el servicio `CoordinatorAgent` en `src/services/coordinator.ts`.
- [x] Modificar `src/index.ts` para instanciar y llamar al Coordinador en vez de procesar inline.
- [x] Realizar pruebas simuladas (dry-run) con `src/test-pipeline.ts` para validar que los matches y logs sigan siendo correctos.
