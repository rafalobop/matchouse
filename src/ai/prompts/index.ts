// BE-08: barrel de los prompts del sistema. Antes (`src/ai/prompts.ts`, un solo archivo con los
// 3 prompts) la versión que se reportaba a `llm_calls`/Langfuse vivía como un string literal
// hardcodeado en cada `operations/*.ts`, desacoplada del texto real del prompt — nada forzaba a
// bumpear la versión al tocar el contenido. Ahora cada prompt vive en su propio archivo con su
// versión exportada al lado del texto (`*_PROMPT_VERSION`), así que `operations/*.ts` importa
// ambos del mismo lugar — un cambio de contenido sin bump de versión salta a la vista en el mismo
// diff. Son todos `const` de solo valor (nunca funciones mockeadas con `t.mock.method`), así que
// re-exportarlos acá no pisa la restricción de mockability que sí aplica a `src/ai/index.ts` (ver
// comentario ahí).
export { SEARCH_INTENT_PROMPT_VERSION, SYSTEM_INSTRUCTIONS_SEARCH_INTENT } from './searchIntent';
export { SEGMENTER_PROMPT_VERSION, SYSTEM_INSTRUCTIONS_SEGMENTER } from './segmenter';
export { EXCEL_MAPPING_PROMPT_VERSION, SYSTEM_INSTRUCTIONS_EXCEL_MAPPING } from './excelMapping';
