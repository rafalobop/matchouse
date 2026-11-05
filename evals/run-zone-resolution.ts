/**
 * BE-21 (EP-07): eval de la resolución de zona (`zonesService.ts#resolveMultipleNeighborhoodsByText`)
 * contra el pipeline real — Supabase real + la API real de embeddings de OpenAI para las
 * menciones que el keyword matching no resuelve (BE-20). A diferencia de `evals/run.ts`
 * (BE-02, mide la EXTRACCIÓN de un LLM), esto mide la RESOLUCIÓN de zona en sí — no hay LLM de
 * por medio, el "modelo" bajo prueba es la combinación keyword + embeddings + pgvector.
 *
 * Objetivo explícito: cuantificar la mejora real que BE-20 le suma a la cobertura que KAN-337 ya
 * había documentado como insuficiente (solo 8/151 zonas con alias curados) — por eso el dataset
 * separa los casos por tag (`keyword`/`alias` ya resolvían antes de BE-20; `semantic-colloquial`
 * es la cobertura nueva; `limitacion-conocida` documenta, con evidencia, los casos donde el
 * fallback semántico TODAVÍA no alcanza — ver el comentario de `SEMANTIC_MATCH_MIN_SIMILARITY` en
 * zonesService.ts para el detalle de por qué esos casos puntuales quedan por debajo del umbral).
 *
 * Uso: pnpm eval:zone-resolution
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveMultipleNeighborhoodsByText, __clearZoneKeywordCacheForTests } from '../src/services/zonesService';

interface ZoneResolutionCase {
  id: string;
  mentions: string[];
  expectedZoneName: string | null;
  tags: string[];
}

interface CaseResult {
  id: string;
  tags: string[];
  pass: boolean;
  expected: string | null;
  resolved: string[];
}

function loadDataset(): ZoneResolutionCase[] {
  const filePath = path.join(__dirname, 'zone-resolution.jsonl');
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function runCase(testCase: ZoneResolutionCase): Promise<CaseResult> {
  // Cache de keywords compartido entre casos a propósito (TTL de 5 min, ver zonesService.ts) —
  // solo se limpia una vez al arrancar (abajo en main()), no por caso: mismo comportamiento que
  // tendría en producción, donde el cache sobrevive entre requests.
  const resolved = await resolveMultipleNeighborhoodsByText(testCase.mentions);
  const resolvedNames = resolved.map((r) => r.name);

  const pass = testCase.expectedZoneName === null
    ? resolvedNames.length === 0
    : resolvedNames.includes(testCase.expectedZoneName);

  return { id: testCase.id, tags: testCase.tags, pass, expected: testCase.expectedZoneName, resolved: resolvedNames };
}

function summarizeByTag(results: CaseResult[]): Record<string, { pass: number; total: number }> {
  const byTag: Record<string, { pass: number; total: number }> = {};
  for (const result of results) {
    for (const tag of result.tags) {
      byTag[tag] = byTag[tag] ?? { pass: 0, total: 0 };
      byTag[tag].total++;
      if (result.pass) byTag[tag].pass++;
    }
  }
  return byTag;
}

async function main(): Promise<void> {
  __clearZoneKeywordCacheForTests();
  const dataset = loadDataset();

  console.log(`Corriendo eval de resolución de zona: ${dataset.length} casos.\n`);

  const results: CaseResult[] = [];
  for (const testCase of dataset) {
    const result = await runCase(testCase);
    results.push(result);
    console.log(`${result.pass ? '✔' : '✖'} ${result.id} [${result.tags.join(', ')}] esperado=${JSON.stringify(result.expected)} resuelto=${JSON.stringify(result.resolved)}`);
  }

  const byTag = summarizeByTag(results);
  const totalPass = results.filter((r) => r.pass).length;

  console.log(`\nTotal: ${totalPass}/${results.length}`);
  console.log('Por tag:');
  for (const [tag, counts] of Object.entries(byTag)) {
    console.log(`  ${tag}: ${counts.pass}/${counts.total}`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(__dirname, 'reports', `${date}-zone-resolution.md`);
  const jsonPath = path.join(__dirname, 'reports', `${date}-zone-resolution.json`);

  const md = [
    `# Reporte de eval — resolución de zona (BE-20/BE-21, EP-07) — ${date}`,
    '',
    'Generado por `pnpm eval:zone-resolution` contra la implementación real de `zonesService.ts`',
    '(Supabase real + API real de embeddings de OpenAI para las menciones sin match de keyword).',
    '',
    `**Total: ${totalPass}/${results.length}**`,
    '',
    '| Tag | Pass | Total |',
    '|---|---|---|',
    ...Object.entries(byTag).map(([tag, counts]) => `| ${tag} | ${counts.pass} | ${counts.total} |`),
    '',
    '| Caso | Tags | Esperado | Resuelto | Resultado |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.tags.join(', ')} | ${JSON.stringify(r.expected)} | ${JSON.stringify(r.resolved)} | ${r.pass ? '✅' : '❌'} |`)
  ].join('\n');

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, md);
  fs.writeFileSync(jsonPath, JSON.stringify({ date, totalPass, total: results.length, byTag, results }, null, 2));

  console.log(`\nReporte escrito en ${reportPath} y ${jsonPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
