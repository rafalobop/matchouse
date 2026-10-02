# Agente Validador / Curador (Validador)

## Estado real (2026-09, verificado por código)
Este documento describe dos cosas distintas que conviene no confundir:

1. **El gating real del pipeline de matching ciego actual** (`POST /api/search`, cross-tenant):
   es **determinístico**, no un LLM — `checkMatch` (`src/utils/matcher.ts`), invocado desde
   `matchRequestAgainstProperties`/`findCrossTenantMatches` (`services/blindMatching.ts`). Compara
   el `ExtractedRealEstateRequest` estructurado del Agente 1 contra cada propiedad candidata por
   reglas explícitas (operación, tipo de propiedad, zona vía `ZoneIntentRequest`, presupuesto,
   dormitorios, country/barrio cerrado, características clave), devolviendo `isMatch`/`score`/
   `reasons`. Ahí se decide si una propiedad entra a `match_queue` y con qué score.
2. **El "Agente Validador" con LLM** descripto abajo (`validateMatch`, `services/ai.ts`,
   `SYSTEM_INSTRUCTIONS_VALIDATOR`) sigue existiendo en el código y tiene su propio prompt/tests
   (`tests/ai.test.ts`), pero **no tiene ningún caller en el flujo actual de matching ciego** —
   ni `blindMatching.ts` ni `searchSegmentProcessor.ts` lo invocan. Es remanente de una etapa
   anterior del pipeline (probablemente la era de curación de matches por WhatsApp, ver
   SPEC-0007) que no fue retirado del código al pivotar a matching 100% web (KAN-64). Si se
   piensa reactivar como una segunda pasada de curación cualitativa sobre los matches que ya
   pasaron el filtro determinístico, hay que decidir explícitamente dónde engancharlo — hoy no
   corre en ningún request real.

## Descripción (del LLM validador, si se reactiva)
Evaluación cualitativa de la coincidencia entre un pedido estructurado y una propiedad candidata,
para evitar falsos positivos que el filtro determinístico no capture.

## Inputs
- `messageTexto` (string): texto original de la búsqueda (ya no "mensaje de WhatsApp" — texto libre
  del formulario web).
- `extractedData` (JSON): datos extraídos por el Agente 1 (`ExtractedRealEstateRequest`).
- `property` (JSON): datos de la propiedad candidata.

## Outputs (Estructurado)
```typescript
interface ValidationResult {
  score: number;    // De 0 a 100
  isValid: boolean; // indica si el match es real y de alta calidad
  reasoning: string; // explicación cualitativa de por qué se considera match o se descarta
}
```

## Reglas de Filtro (si se reactiva)
- Si `isValid === false` o `score < 70`, correspondería marcar el registro en `match_queue` como
  inválido/silenciado (`user_review_status`) y no notificar por push/WS. Hoy ese criterio de corte
  no está implementado en ningún caller real — documentado para no perder el diseño original.
