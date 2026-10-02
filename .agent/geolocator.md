# Agente 2: Geolocalizador / Normalizador de Zona (Geolocator)

## Descripción
Extrae las menciones de ubicación del texto libre de una búsqueda del dashboard web (no un mensaje
de WhatsApp — bot retirado en KAN-64). Desde KAN-22 este agente **no clasifica contra un enum
estático de zonas**: el LLM solo extrae el texto de ubicación tal cual lo escribió el usuario; la
resolución real contra las ~189 zonas de la tabla `neighborhoods`/`neighborhood_aliases` ocurre
DESPUÉS, en código puro (`resolveZoneIntent`, `services/ai.ts`), no en el LLM.

## Modelo Utilizado
- Principal: `gemini-2.5-flash-lite` (vía `@google/genai`)
- Fallback: `gpt-4o-mini` (vía `openai`)

## Inputs
- `messageTexto` (string): el segmento de texto libre de búsqueda.
- `operacion` (string, opcional): operación deducida por el Agente 1 para enriquecer el contexto
  (si el Agente 2 devuelve `DESCONOCIDO`, se rellena con la del Agente 1).

## Outputs (Estructurado)
```typescript
type ZoneStatus = 'INDEFINIDA' | 'DEFINIDA' | 'DESCONOCIDA';

interface ZoneIntentRequest {
  zone_status: ZoneStatus;
  zona_ids: string[];        // UUIDs de neighborhoods.id resueltos (puede haber 2+, alternativas OR)
  zona_nombres: string[];    // neighborhoods.name legibles, mismo orden que zona_ids
  texto_ubicacion_original: string; // texto crudo tal cual lo extrajo el LLM; varias menciones van unidas con ' | '
  dormitorios_min: number | null;
  caracteristicas_claves: string[];
  operacion: 'ALQUILER' | 'COMPRA' | 'DESCONOCIDO';
}
```

## Estados de zona
- **INDEFINIDA**: no se mencionó ninguna ubicación en el texto — la búsqueda no filtra por zona.
- **DEFINIDA**: se resolvió contra `neighborhoods`/`neighborhood_aliases` (1 o más zonas, matcheo
  en OR).
- **DESCONOCIDA**: se mencionó una ubicación pero no se pudo resolver (ni tras 3 reintentos ante
  error de DB/red) — filtro **duro**, bloquea matches hasta que se cure (self-healing, ver
  `blindMatching.ts` y el flag `reengagement_sent` en `active_searches`).

## Reglas de Negocio Clave
1. El LLM extrae texto libre de ubicación (`ubicaciones: string[]`), sin intentar mapearlo a un ID
   fijo — eso ya no es su trabajo desde KAN-22.
2. La resolución contra la tabla real de zonas nunca lanza: un fallo de DB degrada a
   `DESCONOCIDA` en vez de tirar abajo `POST /api/search`.
3. Un "ninguna mención matcheó" legítimo (sin error de DB) NO se reintenta — solo se reintenta ante
   fallo real de la query (hasta 3 veces, `withRetry`).
