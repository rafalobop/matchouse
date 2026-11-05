# Reporte de eval — resolución de zona (BE-20/BE-21, EP-07) — 2026-11-05

Generado por `pnpm eval:zone-resolution` contra la implementación real de `zonesService.ts`
(Supabase real + API real de embeddings de OpenAI para las menciones sin match de keyword).

**Total: 12/12**

| Tag | Pass | Total |
|---|---|---|
| keyword | 4 | 4 |
| alias | 1 | 1 |
| semantic-colloquial | 4 | 4 |
| limitacion-conocida | 2 | 2 |
| sin-sentido | 1 | 1 |
| adversarial | 1 | 1 |
| multi-zona | 1 | 1 |

| Caso | Tags | Esperado | Resuelto | Resultado |
|---|---|---|---|---|
| zr-001 | keyword | "YERBA_BUENA" | ["YERBA_BUENA"] | ✅ |
| zr-002 | keyword | "ZONA_CENTRO" | ["ZONA_CENTRO"] | ✅ |
| zr-003 | alias | "YERBA_BUENA" | ["YERBA_BUENA"] | ✅ |
| zr-004 | keyword | "BARRIO_NORTE" | ["BARRIO_NORTE"] | ✅ |
| zr-005 | semantic-colloquial | "BARRIO_AEROPUERTO" | ["BARRIO_AEROPUERTO"] | ✅ |
| zr-006 | semantic-colloquial | "MONUMENTO_BICENTENARIO" | ["MONUMENTO_BICENTENARIO"] | ✅ |
| zr-007 | semantic-colloquial | "BARRIO_PRIVADO_QUINTA_AZUCENA" | ["BARRIO_PRIVADO_QUINTA_AZUCENA"] | ✅ |
| zr-008 | semantic-colloquial | "CASA_DE_GOBIERNO" | ["CASA_DE_GOBIERNO"] | ✅ |
| zr-009 | limitacion-conocida | null | [] | ✅ |
| zr-010 | limitacion-conocida | null | [] | ✅ |
| zr-011 | sin-sentido, adversarial | null | [] | ✅ |
| zr-012 | multi-zona, keyword | "VILLA_LUJAN" | ["VILLA_LUJAN","ZONA_TAFI_VIEJO"] | ✅ |