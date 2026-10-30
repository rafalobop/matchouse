# Comparativa de modelos — 2026-10-30

Generado por `pnpm eval:compare-models` (evals/compare-models.ts, BE-46) — cada modelo
corre AISLADO (sin el fallback de `AIExtractorContext`) contra los mismos datasets de
`evals/`, para medir accuracy/latencia/costo por modelo sin que un fallo de uno se
tape con el resultado del otro. Ver `docs/model-selection.md` para la tabla resumen y
la decisión final.

## gemini-2.5-flash (candidato "más grande") (`gemini-2.5-flash`)

- **Costo estimado por búsqueda** (extract-intent + zone): $0.000517
- **Costo estimado por 1.000 búsquedas**: $0.52

### extract-intent

- Casos del dataset: 4
- Casos ejecutados sin error de infraestructura: 3
- Errores de ejecución (1): ei-004
- Latencia: p50 2536ms · p95 11236ms · media 5312ms
- Costo medio por llamada: $0.000517

| Métrica | Valor |
|---|---|
| operation (exact match) | 100.0% |
| property_type (exact match) | 100.0% |
| currency (exact match) | 100.0% |
| country (exact match) | 100.0% |
| bedrooms (exact match) | 100.0% |
| max_budget (error absoluto medio) | 0 |
| max_budget (null vs. no-null, tasa de error) | 0.0% |
| zones (precision) | 100.0% |
| zones (recall) | 100.0% |
| key_features (precision) | 100.0% |
| key_features (recall) | 100.0% |
| tasa de DESCONOCIDA/otro | 0.0% |
| tasa de DESCONOCIDA falsa (esperado != desconocido) | 0.0% |

### zone

- Casos del dataset: 4
- Casos ejecutados sin error de infraestructura: 0
- Errores de ejecución (4): z-001, z-002, z-003, z-004
- Latencia: p50 0ms · p95 0ms · media 0ms
- Costo medio por llamada: $0.000000

| Métrica | Valor |
|---|---|
| zona correcta (set exacto de ubicaciones) | 0.0% |
| ubicaciones (precision) | 0.0% |
| ubicaciones (recall) | 0.0% |
| dormitorios_min (exact match) | 0.0% |
| caracteristicas_claves (precision) | 0.0% |
| caracteristicas_claves (recall) | 0.0% |
| operacion (exact match) | 0.0% |
| tasa de DESCONOCIDA/otro | 0.0% |
| tasa de DESCONOCIDA falsa (esperado != desconocido) | 0.0% |

### segment

- Casos del dataset: 4
- Casos ejecutados sin error de infraestructura: 0
- Errores de ejecución (4): seg-001, seg-002, seg-003, seg-004
- Latencia: p50 0ms · p95 0ms · media 0ms
- Costo medio por llamada: $0.000000

| Métrica | Valor |
|---|---|
| cantidad de segmentos correcta | 0.0% |
| segmentos exactamente iguales (texto) | 0.0% |

### excel-mapping

- Casos del dataset: 4
- Casos ejecutados sin error de infraestructura: 0
- Errores de ejecución (4): em-001, em-002, em-003, em-004
- Latencia: p50 0ms · p95 0ms · media 0ms
- Costo medio por llamada: $0.000000

| Métrica | Valor |
|---|---|
| mapeo field→header (accuracy sobre los 11 campos) | 0.0% |
