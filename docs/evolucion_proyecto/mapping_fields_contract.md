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

## `POST /api/upload/confirm-mapping` — corrección parcial (KAN-302, 2026-09-01)

`resolveColumnMapping` (`src/services/excelMapping.ts`) persiste, best-effort y sin confirmar, los
11 campos resueltos por heurística/IA **antes** de devolverle `needs_confirmation` al frontend (ver
docstring de la función). Eso significa que cuando el agente corrige el mapeo desde la UI, la
corrección puede ser parcial — solo los campos que quedaron sin resolver o mal resueltos, sin
reenviar los que ya estaban bien.

Bug corregido: `confirmColumnMapping` armaba el mapeo final únicamente a partir de las claves
presentes en el payload de corrección (`fields`), así que cualquier campo ya bien resuelto que el
agente no reenviaba se perdía del mapeo confirmado — en el peor caso (si el campo perdido era
`domicilio`/`precio`) la confirmación entera se rechazaba con "no resuelve los campos requeridos"
pese a que esos campos sí estaban resueltos, solo que en una fila ya persistida y no en el payload
de esta request.

Fix: `confirmColumnMapping` ahora arranca del mapeo ya guardado en `tenant_excel_mappings` para esa
misma firma de headers (confirmado o no) y lo pisa campo por campo con lo que venga explícito en
`fields` — una corrección parcial ya no borra los campos que no menciona. Tests:
`tests/excelMapping.test.ts` ("KAN-302: una corrección parcial no pisa los campos ya bien
resueltos...").
