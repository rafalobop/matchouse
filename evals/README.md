# Evals — datasets de calidad de extracción LLM

Datasets de casos con respuesta esperada (`expected`) para medir la calidad real de cada
operación de IA del backend (`src/ai/`, ver BE-06), no solo el plumbing que ya cubre
`tests/ai.test.ts` (que mockea el LLM). Implementa BE-01 del backlog de IA.

El runner que ejecuta estos datasets contra el LLM real (`pnpm eval`, `evals/run.ts`) es BE-02 —
corre el pipeline completo de `src/ai/` (con fallback Gemini→OpenAI, como en producción). BE-46
(`pnpm eval:compare-models`, `evals/compare-models.ts`) corre los mismos datasets contra UN modelo
aislado por vez (sin fallback), para comparar accuracy × costo × latencia entre modelos — ver
`docs/model-selection.md`. Las funciones de carga de datasets y cálculo de métricas que usan ambos
scripts viven en `evals/metrics.ts`, no duplicadas.

## Eval gate de CI (BE-05)

`.github/workflows/eval-gate.yml` corre en cada PR que toca `src/ai/**` o `evals/**`: una
muestra chica (`pnpm eval --max-cases 10`) de los 4 datasets, comparada contra el baseline
commiteado en la rama base (`pnpm eval:compare-baseline`, `evals/compare-to-baseline.ts`) — falla
el job si algún campo retrocede más de 5 puntos porcentuales, y publica el resultado como
comentario del PR.
`zone` corre igual (para detectar que el LLM no rompió el schema) pero es **informativo, nunca
gatea**: ese operación necesita una conexión real a Supabase con `neighborhoods` reales para decir
algo más que DESCONOCIDA, y el job corre con credenciales de Supabase dummy (mismo patrón que el
job de tests en `ci.yml`) — no es seguro ni necesario darle a un runner de CI acceso a la base real.

**Configuración requerida** (Settings → Secrets and variables → Actions del repo):
`EVAL_GATE_GEMINI_API_KEY` / `EVAL_GATE_OPENAI_API_KEY`. Sin `EVAL_GATE_GEMINI_API_KEY` el job se
saltea solo (no bloquea ningún PR).

**⚠️ Usar una API key de Gemini separada de la de producción, con facturación habilitada.**
Hallazgo real de BE-46 (ver `docs/model-selection.md`): el free tier de Gemini tiene un límite de
**20 requests/día POR MODELO** (no solo por minuto) — este gate hace ~40 llamadas reales por
corrida (`--max-cases 10` × 4 operaciones). Con una key free-tier, una sola corrida agota casi toda
la cuota diaria; si fuera la misma key de producción, cada PR que toque `ai.ts` degradaría el
servicio real al fallback por el resto del día.

Para subir un nuevo baseline (ej. después de confirmar que un cambio de prompt es una mejora
real), simplemente commitear el `.json`/`.md` que escribe `pnpm eval` sin `--max-cases` — el gate
siempre usa el archivo `evals/reports/YYYY-MM-DD.json` más reciente de la rama base.

## Estado actual (2026-11-05)

Dataset inicial, escrito a mano (no proviene de `active_searches` real — no hubo acceso a datos
de producción al crear este dataset). Las zonas usadas en `extract-intent.jsonl`/`zone.jsonl`/
`segment.jsonl` son lugares reales de San Miguel de Tucumán, Yerba Buena y Tafí Viejo (barrios,
avenidas y countries/barrios privados verificados), no nombres inventados — ver "Realismo de
zonas y presupuestos" más abajo). `extract-intent.jsonl`/`zone.jsonl` son historial de antes de
BE-09 (fusión de Agente 1+2) — ya no los consume ningún script (`evals/metrics.ts#DATASET_FILES`
solo referencia `search-intent`/`segment`/`excel-mapping`), quedan en disco sin borrarse.

| Archivo | Operación | Casos actuales |
|---|---|---|
| `search-intent.jsonl` | Extracción + zona fusionadas (`extractSearchIntent`, BE-09) | 38 |
| `segment.jsonl` | Agente 0 — segmentador (`segmentSearchRequests`) | 33 |
| `excel-mapping.jsonl` | Mapeo de columnas de Excel (`suggestExcelColumnMapping`) | 31 |
| ~~`extract-intent.jsonl`~~ *(histórico, sin usar)* | ex Agente 1 (pre-BE-09) | 78 |
| ~~`zone.jsonl`~~ *(histórico, sin usar)* | ex Agente 2 (pre-BE-09) | 30 |

### Suite adversarial (BE-17, 2026-11-05)

Ampliada de 2 casos `adversarial` por archivo (smoke test) a 8 por archivo (+6 nuevos cada uno),
cubriendo categorías de ataque distintas (tag en `tags`, además de `adversarial`):

- **`tag-breakout`**: el input contiene literalmente la secuencia de cierre del wrapper XML
  (`</USER_TEXT>`/`</EXCEL_HEADERS>`) seguida de una instrucción falsa — ejercita en punta a punta
  la defensa estructural de BE-11 (`escapeForXmlTag`), no solo la instrucción del prompt.
- **`prompt-leak`**: le pide al modelo que repita/revele sus instrucciones de sistema.
- **`jailbreak`**: roleplay/"modo sin restricciones" (estilo DAN) sin ningún contenido inmobiliario
  real — el resultado esperado es el objeto comodín (`'desconocido'`/`'otro'`/arrays vacíos) o, en
  `segment`/`excel-mapping`, degradar a "tratar el texto completo como un solo segmento"/"ningún
  header coincide".
- **`instruccion-ofuscada`**: la instrucción maliciosa va codificada (base64) en vez de en texto
  plano — prueba que ofuscar el ataque no lo vuelve más efectivo.
- **`override-presupuesto`** / **`inyeccion-de-array`** / **`inyeccion-de-campo`**: casos MIXTOS
  (contenido inmobiliario real + instrucción inyectada tratando de forzar un campo numérico, un
  array o un campo extra) — el valor esperado es el que corresponde al contenido REAL, ignorando
  por completo el valor que la inyección intenta forzar. Son los casos más importantes de la
  suite: una inyección que coexiste con una búsqueda legítima es el escenario más realista (un
  usuario real no manda SOLO un ataque, lo esconde dentro de un pedido que parece normal).
- **`force-split-fake`** / **`force-merge-real`** (`segment.jsonl`): instrucción inyectada pidiendo
  dividir un pedido único en varios, o fusionar dos pedidos genuinamente distintos en uno — el
  segmentador debe seguir las reglas reales de segmentación, no la instrucción inyectada.
- **`header-malicioso`** / **`injection-sql-like`** / **`redefinicion-de-campo`**
  (`excel-mapping.jsonl`): un header de columna que es en sí mismo una instrucción, un string
  típico de inyección SQL, o un intento de redefinir qué significa un campo de negocio — en los
  tres casos el header malicioso debe mapear a `null` en todos los campos, sin desplazar al header
  legítimo real que sí corresponde.

No se migraron ni se tocaron los 2 casos `adversarial` previos de cada archivo — los 6 nuevos se
suman a ellos (8 por archivo en total ahora), sin reemplazarlos.

## Formato

Un objeto JSON por línea (JSONL), UTF-8, sin casos vacíos al final del archivo.

Campos comunes a los 4 archivos:
- `id`: identificador único y estable dentro del archivo (prefijo por operación: `ei-`, `z-`,
  `seg-`, `em-`). No reusar ni reordenar IDs existentes — un reporte de evals puede referenciarlos.
- `input`: el input real que recibe la función de la operación (ver detalle por archivo abajo).
- `expected`: la salida esperada, en el mismo shape que devuelve la función pública de
  `src/ai/` para esa operación (después de normalizar, no la respuesta cruda del LLM).
- `tags`: array de strings para filtrar/agrupar casos en los reportes. Tags en uso: `zona-explicita`,
  `moneda-explicita`, `moneda-implicita`, `multi-zona`, `multi-busqueda`, `multi-feature`,
  `caracteristica-especial`, `typo`, `ruido-whatsapp`, `adversarial`, `sin-presupuesto`,
  `sin-zona`, `monoambiente`, `country-si`, `country-no`, `country-indiferente`,
  `operacion-implicita`, `formato-numerico`, `edge-case`, `sin-sentido`, entre otros
  autoexplicativos. Agregar tags nuevos libremente; no hace falta registrarlos en ningún lado.
  **Subtags de `adversarial` (BE-17)**: `tag-breakout`, `prompt-leak`, `jailbreak`,
  `instruccion-ofuscada`, `override-presupuesto`, `inyeccion-de-array`, `inyeccion-de-campo`,
  `force-split-fake`, `force-merge-real`, `header-malicioso`, `injection-sql-like`,
  `redefinicion-de-campo` — ver detalle de cada categoría más abajo.

### `extract-intent.jsonl` (Agente 1)

- `input`: `string` — el texto libre tal cual lo escribiría un usuario en el formulario de
  búsqueda (lo que recibe `extractFromTextInput(freeText)`).
- `expected`: objeto `ExtractedRealEstateRequest` (ver `src/ai/`): `operation`,
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
  `operacion_hint` aplicado (ver `toZoneIntentPlaceholder` en `src/ai/operations/extractZoneIntent.ts`): `ubicaciones` (menciones de
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

## `zone-resolution.jsonl` + `pnpm eval:zone-resolution` (BE-20/BE-21, EP-07)

A diferencia de los 3 datasets de arriba (que miden la EXTRACCIÓN de un LLM), este mide la
RESOLUCIÓN de zona en sí — no hay LLM de por medio. El "modelo" bajo prueba es
`zonesService.ts#resolveMultipleNeighborhoodsByText`: keyword matching contra
`neighborhoods`/`neighborhood_aliases` primero, y si no encuentra nada, fallback semántico
(embeddings de OpenAI `text-embedding-3-small` + búsqueda por similitud de coseno en pgvector,
BE-20) antes de dejar la mención sin resolver.

- `input`: `{ "mentions": string[] }` — una o más menciones de ubicación, mismo shape que recibe
  `resolveMultipleNeighborhoodsByText`.
- `expected`: `{ "expectedZoneName": string | null }` — el `neighborhoods.name` (técnico, ej.
  `"BARRIO_AEROPUERTO"`) que debe aparecer entre los resueltos, o `null` si el caso espera que
  NINGUNA mención resuelva.
- Tags en uso: `keyword`/`alias` (ya resolvían antes de BE-20, sirven de regresión — confirman que
  el fallback semántico nunca se interpone cuando el keyword matching ya encontró algo),
  `semantic-colloquial` (la cobertura nueva de BE-20: frases que NO contienen ningún
  keyword/alias curado pero sí identifican una zona real sin ambigüedad), `limitacion-conocida`
  (casos donde el fallback semántico, a propósito, NO resuelve — el texto embebido de esa zona es
  muy escueto para la frase, mejor dejar sin resolver que forzar una zona incorrecta con falsa
  confianza; ver el comentario de `SEMANTIC_MATCH_MIN_SIMILARITY` en `zonesService.ts`), más los
  tags genéricos ya documentados arriba (`adversarial`, `sin-sentido`, `multi-zona`).
- **Corre contra servicios reales, no mocks:** Supabase real (`neighborhoods`/`neighborhood_aliases`
  reales) y la API real de embeddings de OpenAI para las menciones sin match de keyword — mismo
  criterio de "nunca mockear el sistema bajo prueba" que `evals/run.ts` (BE-02).
- Reporte: `evals/reports/YYYY-MM-DD-zone-resolution.{md,json}`, con el desglose pass/total por tag
  (la forma más directa de ver, con evidencia, cuánta cobertura nueva le suma el fallback semántico
  sobre la base de 8/151 zonas con alias curados que KAN-337 ya había documentado).
