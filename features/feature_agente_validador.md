# Feature: Agente Validador / Curador de Matches

## Descripción
Esta feature incorpora el **Agente Validador** en el ciclo de vida del Coordinador para evaluar matches físicos cualitativamente antes de disparar notificaciones de WhatsApp.

## Objetivos
1. Definir el prompt de sistema del Agente Validador en `gemini.ts` con el esquema JSON de salida adecuado.
2. Integrar el validador en `src/services/coordinator.ts`.
3. Aplicar la política de *Gatekeeper* (umbral de score > 70% e `isValid === true`).

## Tareas
- [x] Implementar el método de validación de match en `src/services/gemini.ts`.
- [x] Conectar el validador en el loop de coincidencia del Coordinador.
- [x] Guardar los resultados detallados de la validación (score, razonamiento) en la persistencia local.
