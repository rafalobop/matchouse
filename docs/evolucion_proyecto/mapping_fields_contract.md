# Contrato compartido de MAPPING_FIELDS (KAN-215)

## Qué es

`MAPPING_FIELDS` es la lista de campos de negocio que el motor de mapeo de columnas de Excel
(`src/services/excelMapping.ts`, KAN-84) sabe reconocer en una hoja de cartera subida por un
tenant: `domicilio`, `piso_lote`, `precio`, `expensas`, `dormitorios`, `caracteristicas`,
`contacto`, `tipo`, `operacion`, `latitud`, `longitud`.

Antes de este ticket, el frontend legacy (`src/dashboard/app.js`) tenía su propia copia
hardcodeada de esta lista para renderizar el modal de confirmación de mapeo — sin ningún
mecanismo que detectara si divergía de la lista real del backend (`EXCEL_MAPPING_FIELDS` en
`src/utils/excelHeaderMatcher.ts`). Riesgo documentado en `MIGRATION_PLAN.md` §7.

## Fuente de verdad

`src/utils/excelHeaderMatcher.ts` es la única fuente de verdad:

- `EXCEL_MAPPING_FIELDS`: la lista completa de campos reconocidos.
- `REQUIRED_EXCEL_MAPPING_FIELDS`: subset (`domicilio`, `precio`) sin el cual
  `resolveColumnMapping()` nunca da un mapeo por `ready` — coincide con el guard histórico de
  `processExcelBuffer` (ver comentario en el propio archivo).
- `EXCEL_MAPPING_FIELDS_VERSION`: entero que se bumpea a mano cada vez que cualquiera de las dos
  listas de arriba cambia (agregar, quitar o renombrar un campo). Es la única señal de auditoría
  del contrato — no hay changelog automático.

## Cómo se expone

`GET /api/upload/mapping-fields` (`src/routes/upload.ts`, KAN-215) devuelve:

```json
{ "version": 1, "fields": ["domicilio", "piso_lote", ...], "required": ["domicilio", "precio"] }
```

Público, sin `tenantAuthMiddleware` — mismo criterio que `GET /api/system/config-status`
(KAN-122): es metadata estática de negocio, no datos de un tenant.

## Regla de negocio

Cualquier cambio a `EXCEL_MAPPING_FIELDS` o `REQUIRED_EXCEL_MAPPING_FIELDS` en
`excelHeaderMatcher.ts` **debe** ir acompañado de un bump de `EXCEL_MAPPING_FIELDS_VERSION` en el
mismo commit. El frontend (`brokaza-frontend`, KAN-215/216/217) consume este endpoint en vez de
mantener su propia copia hardcodeada, así que un cambio sin bump de versión es indistinguible de
"no cambió nada" para quien esté auditando el contrato desde el otro lado.
