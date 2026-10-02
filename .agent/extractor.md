# Agente 1: Extractor de Entidades (Extractor)

## Descripción
Procesa el texto libre de una búsqueda publicada por un tenant desde el dashboard web (no un
mensaje de WhatsApp — el bot de WhatsApp fue retirado en KAN-64, ver `.agent/CONTEXT.md`). Extrae
entidades del negocio estructuradas para el sector inmobiliario en Tucumán.

## Función real
`extractFromTextInput(freeText)` en `src/services/ai.ts`, detrás del flag
`FREE_TEXT_EXTRACTION_ENABLED`. Existe también `extractFromWhatsApp` (mismo extractor interno,
nombre heredado de KAN-36) pero no tiene consumidor real: el único camino en producción es
`extractFromTextInput`, llamado desde `searchController.ts#createSearch` una vez por cada segmento
que devuelve el Agente 0 (`segmentSearchRequests`).

## Modelo Utilizado
- Principal: `gemini-2.5-flash-lite` (vía `@google/genai`)
- Fallback: `gpt-4o-mini` (vía `openai`)

## Inputs
- `freeText` (string): un segmento de texto libre de búsqueda (español, sin estructura fija).

## Outputs (Estructurado)
```typescript
interface ExtractedRealEstateRequest {
  operation: 'venta' | 'alquiler' | 'desconocido';
  property_type: 'departamento' | 'casa' | 'terreno' | 'local' | 'oficina' | 'otro';
  zones: string[];
  max_budget: number | null;
  currency: 'USD' | 'ARS' | 'desconocido';
  bedrooms: number | null;
  key_features: string[];
  country: 'si' | 'no' | 'indiferente';
}
```
(Nombres de campo en inglés desde SPEC-0012 — antes eran `operacion`/`tipo_propiedad`/`zonas`/etc.)

## Reglas de Negocio Clave
1. **Operación**: Determina si es venta o alquiler. Si no es explícito, busca términos secundarios
   como "Busco", "Necesito", etc.
2. **Ubicaciones Básicas**: Normaliza a municipios principales ("San Miguel de Tucumán", "Yerba
   Buena", "Tafí Viejo"). La resolución fina a zona/barrio la hace el Agente 2 (`geolocator.md`),
   no este agente.
3. **Presupuesto y Moneda**: Deduce moneda por el tipo de operación si no se especifica (compra ->
   USD, alquiler -> ARS).
4. **Country**: Identifica si se solicita estar dentro ("si"), fuera ("no") o si es indiferente.

## Manejo de fallas (KAN-339, 2026-09-10)
Si todas las estrategias de IA (Gemini + fallback OpenAI) fallan, este agente **ya no degrada en
silencio** a `operation:'desconocido'`/`property_type:'otro'` (esos valores actúan como comodín en
el matcher, publicando la búsqueda igual sin avisar al usuario del fallo real). Ahora siempre
lanza: `AITimeoutError` si el fallo fue por timeout, o el nuevo `AIExtractionFailedError` para
cualquier otro motivo. `searchController.ts` responde `502`/`AI_EXTRACTION_FAILED` en ese caso —
el segmento no se publica como búsqueda "vacía".
