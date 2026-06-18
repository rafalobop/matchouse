# Feature: Curación de Matches e Interfaz de Feedback (Spec 0007)

## Descripción
Esta feature incorpora un mecanismo de curación humano en el dashboard para que los operadores inmobiliarios puedan aceptar o rechazar matches generados por la IA, guardando retroalimentación de valor para mejorar los agentes.

## Objetivos
1. Agregar las columnas `userReviewStatus` y `feedbackReason` en la tabla `Match` de Supabase.
2. Implementar el endpoint `POST /api/matches/:id/feedback` para actualizar el estado del match.
3. Actualizar la interfaz del Dashboard Express para añadir controles visuales de curación.
4. Diseñar un modal interactivo para capturar los motivos de rechazo.
