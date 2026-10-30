# Comparativa de modelos — 2026-10-30

Generado por `pnpm eval:compare-models` (evals/compare-models.ts, BE-46) — cada modelo
corre AISLADO (sin el fallback de `AIExtractorContext`) contra los mismos datasets de
`evals/`, para medir accuracy/latencia/costo por modelo sin que un fallo de uno se
tape con el resultado del otro. Ver `docs/model-selection.md` para la tabla resumen y
la decisión final.

## gemini-2.5-flash-lite (primario actual) (`gemini-2.5-flash-lite`)

- **Costo estimado por búsqueda** (extract-intent + zone): $0.000163
- **Costo estimado por 1.000 búsquedas**: $0.16

### extract-intent

- Casos del dataset: 78
- Casos ejecutados sin error de infraestructura: 10
- Errores de ejecución (68): ei-001, ei-012, ei-013, ei-014, ei-015, ei-016, ei-017, ei-018, ei-019, ei-020, ei-021, ei-022, ei-023, ei-024, ei-025, ei-026, ei-027, ei-028, ei-029, ei-030, ei-031, ei-032, ei-033, ei-034, ei-035, ei-036, ei-037, ei-038, ei-039, ei-040, ei-041, ei-042, ei-043, ei-044, ei-045, ei-046, ei-047, ei-048, ei-049, ei-050, ei-051, ei-052, ei-053, ei-054, ei-055, ei-056, ei-057, ei-058, ei-059, ei-060, ei-061, ei-062, ei-063, ei-064, ei-065, ei-066, ei-067, ei-068, ei-069, ei-070, ei-071, ei-072, ei-073, ei-074, ei-075, ei-076, ei-077, ei-078
- Latencia: p50 813ms · p95 4336ms · media 1264ms
- Costo medio por llamada: $0.000163

| Métrica | Valor |
|---|---|
| operation (exact match) | 100.0% |
| property_type (exact match) | 100.0% |
| currency (exact match) | 100.0% |
| country (exact match) | 100.0% |
| bedrooms (exact match) | 100.0% |
| max_budget (error absoluto medio) | 0 |
| max_budget (null vs. no-null, tasa de error) | 0.0% |
| zones (precision) | 65.0% |
| zones (recall) | 65.0% |
| key_features (precision) | 100.0% |
| key_features (recall) | 100.0% |
| tasa de DESCONOCIDA/otro | 0.0% |
| tasa de DESCONOCIDA falsa (esperado != desconocido) | 0.0% |

### zone

- Casos del dataset: 30
- Casos ejecutados sin error de infraestructura: 0
- Errores de ejecución (30): z-001, z-002, z-003, z-004, z-005, z-006, z-007, z-008, z-009, z-010, z-011, z-012, z-013, z-014, z-015, z-016, z-017, z-018, z-019, z-020, z-021, z-022, z-023, z-024, z-025, z-026, z-027, z-028, z-029, z-030
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

- Casos del dataset: 27
- Casos ejecutados sin error de infraestructura: 0
- Errores de ejecución (27): seg-001, seg-002, seg-003, seg-004, seg-005, seg-006, seg-007, seg-008, seg-009, seg-010, seg-011, seg-012, seg-013, seg-014, seg-015, seg-016, seg-017, seg-018, seg-019, seg-020, seg-021, seg-022, seg-023, seg-024, seg-025, seg-026, seg-027
- Latencia: p50 0ms · p95 0ms · media 0ms
- Costo medio por llamada: $0.000000

| Métrica | Valor |
|---|---|
| cantidad de segmentos correcta | 0.0% |
| segmentos exactamente iguales (texto) | 0.0% |

### excel-mapping

- Casos del dataset: 25
- Casos ejecutados sin error de infraestructura: 10
- Errores de ejecución (15): em-001, em-002, em-003, em-004, em-005, em-008, em-017, em-018, em-019, em-020, em-021, em-022, em-023, em-024, em-025
- Latencia: p50 1230ms · p95 1786ms · media 1302ms
- Costo medio por llamada: $0.000210

| Métrica | Valor |
|---|---|
| mapeo field→header (accuracy sobre los 11 campos) | 99.1% |

## gpt-4o-mini (fallback actual) (`gpt-4o-mini`)

- **Costo estimado por búsqueda** (extract-intent + zone): $0.000359
- **Costo estimado por 1.000 búsquedas**: $0.36

### extract-intent

- Casos del dataset: 78
- Casos ejecutados sin error de infraestructura: 78
- Latencia: p50 1250ms · p95 1956ms · media 1358ms
- Costo medio por llamada: $0.000234

| Métrica | Valor |
|---|---|
| operation (exact match) | 97.4% |
| property_type (exact match) | 94.9% |
| currency (exact match) | 97.4% |
| country (exact match) | 94.9% |
| bedrooms (exact match) | 98.7% |
| max_budget (error absoluto medio) | 0 |
| max_budget (null vs. no-null, tasa de error) | 0.0% |
| zones (precision) | 64.7% |
| zones (recall) | 64.7% |
| key_features (precision) | 99.4% |
| key_features (recall) | 100.0% |
| tasa de DESCONOCIDA/otro | 5.1% |
| tasa de DESCONOCIDA falsa (esperado != desconocido) | 2.6% |

### zone

- Casos del dataset: 30
- Casos ejecutados sin error de infraestructura: 30
- Latencia: p50 1265ms · p95 1896ms · media 1291ms
- Costo medio por llamada: $0.000125

| Métrica | Valor |
|---|---|
| zona correcta (set exacto de ubicaciones) | 100.0% |
| ubicaciones (precision) | 100.0% |
| ubicaciones (recall) | 100.0% |
| dormitorios_min (exact match) | 100.0% |
| caracteristicas_claves (precision) | 100.0% |
| caracteristicas_claves (recall) | 100.0% |
| operacion (exact match) | 96.7% |
| tasa de DESCONOCIDA/otro | 10.0% |
| tasa de DESCONOCIDA falsa (esperado != desconocido) | 0.0% |

### segment

- Casos del dataset: 27
- Casos ejecutados sin error de infraestructura: 27
- Latencia: p50 1099ms · p95 1859ms · media 1170ms
- Costo medio por llamada: $0.000153

| Métrica | Valor |
|---|---|
| cantidad de segmentos correcta | 100.0% |
| segmentos exactamente iguales (texto) | 66.7% |

### excel-mapping

- Casos del dataset: 25
- Casos ejecutados sin error de infraestructura: 25
- Latencia: p50 2650ms · p95 3338ms · media 2703ms
- Costo medio por llamada: $0.000207

| Métrica | Valor |
|---|---|
| mapeo field→header (accuracy sobre los 11 campos) | 97.1% |

## gemini-2.5-flash (candidato "más grande") (`gemini-2.5-flash`)

- **Costo estimado por búsqueda** (extract-intent + zone): $0.000770
- **Costo estimado por 1.000 búsquedas**: $0.77

### extract-intent

- Casos del dataset: 78
- Casos ejecutados sin error de infraestructura: 8
- Errores de ejecución (70): ei-009, ei-010, ei-011, ei-012, ei-013, ei-014, ei-015, ei-016, ei-017, ei-018, ei-019, ei-020, ei-021, ei-022, ei-023, ei-024, ei-025, ei-026, ei-027, ei-028, ei-029, ei-030, ei-031, ei-032, ei-033, ei-034, ei-035, ei-036, ei-037, ei-038, ei-039, ei-040, ei-041, ei-042, ei-043, ei-044, ei-045, ei-046, ei-047, ei-048, ei-049, ei-050, ei-051, ei-052, ei-053, ei-054, ei-055, ei-056, ei-057, ei-058, ei-059, ei-060, ei-061, ei-062, ei-063, ei-064, ei-065, ei-066, ei-067, ei-068, ei-069, ei-070, ei-071, ei-072, ei-073, ei-074, ei-075, ei-076, ei-077, ei-078
- Latencia: p50 1935ms · p95 6880ms · media 2633ms
- Costo medio por llamada: $0.000511

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
| zones (recall) | 93.8% |
| key_features (precision) | 100.0% |
| key_features (recall) | 100.0% |
| tasa de DESCONOCIDA/otro | 0.0% |
| tasa de DESCONOCIDA falsa (esperado != desconocido) | 0.0% |

### zone

- Casos del dataset: 30
- Casos ejecutados sin error de infraestructura: 7
- Errores de ejecución (23): z-001, z-002, z-003, z-004, z-005, z-006, z-007, z-008, z-009, z-010, z-011, z-012, z-013, z-014, z-015, z-016, z-017, z-018, z-019, z-020, z-021, z-023, z-030
- Latencia: p50 2106ms · p95 3199ms · media 2140ms
- Costo medio por llamada: $0.000259

| Métrica | Valor |
|---|---|
| zona correcta (set exacto de ubicaciones) | 100.0% |
| ubicaciones (precision) | 100.0% |
| ubicaciones (recall) | 100.0% |
| dormitorios_min (exact match) | 100.0% |
| caracteristicas_claves (precision) | 100.0% |
| caracteristicas_claves (recall) | 100.0% |
| operacion (exact match) | 100.0% |
| tasa de DESCONOCIDA/otro | 0.0% |
| tasa de DESCONOCIDA falsa (esperado != desconocido) | 0.0% |

### segment

- Casos del dataset: 27
- Casos ejecutados sin error de infraestructura: 1
- Errores de ejecución (26): seg-001, seg-002, seg-003, seg-005, seg-006, seg-007, seg-008, seg-009, seg-010, seg-011, seg-012, seg-013, seg-014, seg-015, seg-016, seg-017, seg-018, seg-019, seg-020, seg-021, seg-022, seg-023, seg-024, seg-025, seg-026, seg-027
- Latencia: p50 1910ms · p95 1910ms · media 1910ms
- Costo medio por llamada: $0.000389

| Métrica | Valor |
|---|---|
| cantidad de segmentos correcta | 100.0% |
| segmentos exactamente iguales (texto) | 100.0% |

### excel-mapping

- Casos del dataset: 25
- Casos ejecutados sin error de infraestructura: 0
- Errores de ejecución (25): em-001, em-002, em-003, em-004, em-005, em-006, em-007, em-008, em-009, em-010, em-011, em-012, em-013, em-014, em-015, em-016, em-017, em-018, em-019, em-020, em-021, em-022, em-023, em-024, em-025
- Latencia: p50 0ms · p95 0ms · media 0ms
- Costo medio por llamada: $0.000000

| Métrica | Valor |
|---|---|
| mapeo field→header (accuracy sobre los 11 campos) | 0.0% |
