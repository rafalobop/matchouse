# Reporte de eval — crédito semántico de características (BE-24/BE-25, EP-07) — 2026-11-05

Generado por `pnpm eval:feature-matching` contra `FeaturesMatchingStrategy` real, con
embeddings reales de OpenAI para ambos lados de cada caso.

**Total: 5/5**

| Caso | Tags | Esperado | Real | Resultado |
|---|---|---|---|---|
| fm-001 | keyword | false | false | ✅ |
| fm-002 | semantic-colloquial | true | true | ✅ |
| fm-003 | limitacion-conocida | false | false | ✅ |
| fm-004 | limitacion-conocida | false | false | ✅ |
| fm-005 | control-negativo | false | false | ✅ |