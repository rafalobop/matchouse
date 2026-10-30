# Evals — datasets de calidad de extracción LLM

Datasets de casos con respuesta esperada (`expected`) para medir la calidad real de cada
operación de IA del backend (`src/services/ai.ts`), no solo el plumbing que ya cubre
`tests/ai.test.ts` (que mockea el LLM). Implementa BE-01 del backlog de IA.

El runner que ejecuta estos datasets contra el LLM real (`pnpm eval`, `evals/run.ts`) es BE-02 —
corre el pipeline completo de `ai.ts` (con fallback Gemini→OpenAI, como en producción). BE-46
(`pnpm eval:compare-models`, `evals/compare-models.ts`) corre los mismos datasets contra UN modelo
aislado por vez (sin fallback), para comparar accuracy × costo × latencia entre modelos — ver
`docs/model-selection.md`. Las funciones de carga de datasets y cálculo de métricas que usan ambos
scripts viven en `evals/metrics.ts`, no duplicadas.

## Estado actual (2026-10-29)

Dataset inicial, escrito a mano (no proviene de `active_searches` real — no hubo acceso a datos
de producción al crear este dataset). Las zonas usadas en `extract-intent.jsonl`/`zone.jsonl`/
`segment.jsonl` son lugares reales de San Miguel de Tucumán, Yerba Buena y Tafí Viejo (barrios,
avenidas y countries/barrios privados verificados), no nombres inventados — ver "Realismo de
zonas y presupuestos" más abajo). **`excel-mapping` ya cumple el umbral mínimo del AC de BE-01**
(≥20); `extract-intent`, `zone` y `segment` todavía no llegan a los suyos (≥100, ≥60 y ≥40
respectivamente), aunque ya están razonablemente cerca. Pensado para crecer con casos reales
anonimizados (ver "Cómo agregar casos").

| Archivo | Operación | Casos actuales | Objetivo (AC de BE-01) |
|---|---|---|---|
| `extract-intent.jsonl` | Agente 1 — extracción de texto libre (`extractFromTextInput`) | 78 | ≥100 |
| `zone.jsonl` | Agente 2 — intención de zona (`extractZoneIntent`) | 30 | ≥60 |
| `segment.jsonl` | Agente 0 — segmentador (`segmentSearchRequests`) | 27 | ≥40 |
| `excel-mapping.jsonl` | Mapeo de columnas de Excel (`suggestExcelColumnMapping`) | 25 | ≥20 ✅ |

La suite adversarial completa (más casos de prompt injection) es alcance de BE-17, no de este
ticket — cada archivo acá tiene solo 1-2 casos `adversarial` como smoke test.

## Formato

Un objeto JSON por línea (JSONL), UTF-8, sin casos vacíos al final del archivo.

Campos comunes a los 4 archivos:
- `id`: identificador único y estable dentro del archivo (prefijo por operación: `ei-`, `z-`,
  `seg-`, `em-`). No reusar ni reordenar IDs existentes — un reporte de evals puede referenciarlos.
- `input`: el input real que recibe la función de la operación (ver detalle por archivo abajo).
- `expected`: la salida esperada, en el mismo shape que devuelve la función pública de
  `src/services/ai.ts` para esa operación (después de normalizar, no la respuesta cruda del LLM).
- `tags`: array de strings para filtrar/agrupar casos en los reportes. Tags en uso: `zona-explicita`,
  `moneda-explicita`, `moneda-implicita`, `multi-zona`, `multi-busqueda`, `multi-feature`,
  `caracteristica-especial`, `typo`, `ruido-whatsapp`, `adversarial`, `sin-presupuesto`,
  `sin-zona`, `monoambiente`, `country-si`, `country-no`, `country-indiferente`,
  `operacion-implicita`, `formato-numerico`, `edge-case`, `sin-sentido`, entre otros
  autoexplicativos. Agregar tags nuevos libremente; no hace falta registrarlos en ningún lado.

### `extract-intent.jsonl` (Agente 1)

- `input`: `string` — el texto libre tal cual lo escribiría un usuario en el formulario de
  búsqueda (lo que recibe `extractFromTextInput(freeText)`).
- `expected`: objeto `ExtractedRealEstateRequest` (ver `src/services/ai.ts`): `operation`,
  `property_type`, `zones`, `max_budget`, `currency`, `bedrooms`, `key_features`, `country`.
- Los `zones` esperados respetan el mapeo de barrios a municipios que hoy vive hardcodeado en el
  prompt del Agente 1 (SYSTEM_INSTRUCTIONS_AGENT1, regla 3) — ese mapeo se va a eliminar en BE-10,
  momento en el que estos casos van a necesitar actualizarse para dejar las zonas sin normalizar.
- **Hallazgo de la primera corrida real (BE-02, 2026-10-29):** el modelo generaliza esa regla más
  allá de los 3 alias explícitos del prompt — una avenida/barrio real de San Miguel de Tucumán o
  Yerba Buena (confirmado con llamadas reales, ej. "avenida mate de luna" → `"San Miguel de
  Tucumán"`, "villa 9 de julio" → `"San Miguel de Tucumán"`) se normaliza al municipio igual que
  los alias documentados. Esto es correcto y deseado: `matcher.ts`
  (`LocationMatchingStrategy`/rama de fallback sin Agente 2) compara `request.zones` por
  **igualdad exacta** contra `property.zone_display_name`, que solo toma los 3 valores de
  municipio — una zona literal como `"avenida mate de luna"` nunca matchearía ninguna propiedad
  real. Por eso `expected.zones` en los casos `direccion-real` usa el municipio
  (`"San Miguel de Tucumán"` / `"Yerba Buena"`), no el texto literal de la avenida/barrio/country,
  salvo en los countries y barrios privados menos conocidos (Los Cedros, Country Las Yungas, etc.)
  donde el modelo todavía falla de forma visible (devuelve texto basura tipo `"desconocido"` o
  `"indiferente"` en el array `zones`, cruzado con otro campo del schema) — ahí se deja
  `"Yerba Buena"` igual como ground truth correcto de negocio, aceptando que hoy el eval va a
  marcar esos casos como fallidos: es una brecha de calidad real, no un error del dataset.
  `zone.jsonl` (Agente 2) NO sufre este problema — su prompt pide expresamente no normalizar
  (`"sin interpretar ni normalizar"`), y la corrida real lo confirmó al 100%.

### `zone.jsonl` (Agente 2)

- `input`: `string` — el texto a clasificar (lo que recibe `extractZoneIntent(messageTexto, operacion?)`).
- `operacion_hint`: `'venta' | 'alquiler' | null` — la operación ya detectada por el Agente 1, si
  el caso la simula (tercer argumento opcional de `extractZoneIntent`). `null` si el caso no pasa
  ninguna.
- `expected`: solo los 4 campos que el LLM controla directamente, ya con el fill de
  `operacion_hint` aplicado (ver `normalizeAgent2` en `ai.ts`): `ubicaciones` (menciones de
  ubicación en texto plano, SIN resolver contra `neighborhoods` — esa resolución pasa por DB en
  `resolveZoneIntent` y no es parte de este dataset), `dormitorios_min`, `caracteristicas_claves`,
  `operacion` (`'ALQUILER' | 'COMPRA' | 'DESCONOCIDO'`).

### `segment.jsonl` (Agente 0)

- `input`: `string` — el mensaje completo (lo que recibe `segmentSearchRequests(freeText)`).
- `expected`: `{ "segments": string[] }`. Un mensaje con un solo pedido (incluso con zonas
  alternativas conectadas por "o") espera exactamente 1 segmento igual al texto completo.

### `excel-mapping.jsonl` (mapeo de columnas de Excel)

- `input`: `{ "headers": string[] }` — los headers de la planilla, en orden (lo que recibe
  `suggestExcelColumnMapping(headers)`).
- `expected`: `{ "mapping": { field: string, header: string | null }[] }` — una entrada por cada
  uno de los 11 campos de `EXCEL_MAPPING_FIELDS` (`src/utils/excelHeaderMatcher.ts`), siempre en
  ese orden. A propósito **no incluye `confidence`**: es un valor subjetivo del LLM, no algo contra
  lo que tenga sentido comparar exact-match: BE-02 puede decidir cómo (o si) evaluarlo por separado.

## Realismo de zonas y presupuestos

Para que los casos sean representativos del mercado real de Tucumán (no solo válidos contra el
schema) se siguieron estas reglas de precio al redactar `expected.max_budget`/`expected.currency`:

- **Venta**: siempre `USD`, nunca por debajo de **80.000 USD** (piso real de mercado para una
  propiedad en Tucumán).
- **Alquiler en pesos (ARS)**: departamentos entre **400.000 y 800.000 ARS**; casas/dúplex desde
  **800.000 ARS** en adelante (un dúplex se extrae como `property_type: "casa"` — el schema de
  `ExtractedRealEstateRequest` no tiene un valor específico para dúplex).
- **Alquiler en dólares (USD)**: nunca por encima de **2.000 USD/mes**, piso de **500 USD/mes**.

Las zonas mencionadas en los textos (`avenida mate de luna`, `avenida aconquija`, `villa 9 de
julio`, `villa urquiza`, `ciudadela`, `floresta`, `don bosco`, `villa luján`, `villa alem`, `villa
amalia`, `microcentro`, `el bajo`, countries como `country las yungas`/`yerba buena golf club`/
`jockey club de tucumán`/`country de pilar`/`los azahares`/`terrazas del seminario`, barrios
privados como `lomas de yerba buena`/`los cedros`/`los olivos`/`las rosas`/`la rinconada`) son
lugares reales de San Miguel de Tucumán, Yerba Buena y alrededores (fuentes: Wikipedia, La
Gaceta, Municipalidad de SMT y literatura académica sobre countries de Yerba Buena). Los que no
están en la lista hardcodeada de alias de `SYSTEM_INSTRUCTIONS_AGENT1` (solo Barrio Norte/Barrio
Sur/Centro/SMT/4 Avenidas → San Miguel de Tucumán, Yerba Buena/YB/El Corte/Marcos Paz/San José →
Yerba Buena, Tafí Viejo/Lomas de Tafí → Tafí Viejo) se esperan **sin normalizar** en `zones`/
`ubicaciones`, tal cual los escribió el usuario — ver nota sobre BE-10 arriba.

## Cómo agregar casos

1. Elegí el archivo según la operación y sumá una línea JSON válida al final, respetando el
   formato de arriba y el prefijo de `id` correspondiente (siguiente número disponible).
2. Sin datos personales: si el caso sale de una búsqueda real (`active_searches.raw_text`/
   `criteria`), anonimizalo a mano antes de sumarlo (sacar nombres, teléfonos, direcciones
   puntuales) — no pegar el dato crudo de producción.
3. Agregá al menos un tag que describa qué hace especial al caso (la lista de tags en uso está
   arriba; no hace falta que sea exhaustiva, pero ayuda a que los reportes de BE-02 agrupen bien).
4. Si el caso ejercita una regla nueva de un prompt (ej. un sinónimo de feature que no estaba
   cubierto), dejalo explícito en el `id` o en un comentario en el PR — no hace falta anotarlo en
   este README.
