/**
 * BE-25 (EP-07, segunda tanda): eval del crédito semántico de características
 * (`matcher.ts#FeaturesMatchingStrategy`, BE-24) contra el pipeline real — Supabase no interviene
 * acá (es una función pura), pero SÍ la API real de embeddings de OpenAI para ambos lados de la
 * comparación (lo que pide la búsqueda vs. lo que describe la propiedad).
 *
 * Objetivo explícito: cuantificar, con casos reales, cuándo el crédito semántico efectivamente
 * se activa (`semantic-colloquial`) y documentar con evidencia los casos donde el umbral
 * (`SEMANTIC_FEATURES_MIN_SIMILARITY`, matcher.ts) NO alcanza (`limitacion-conocida`) — mismo
 * criterio honesto que `evals/zone-resolution.jsonl` (BE-21) ya aplicó para el fallback de zonas.
 *
 * Uso: pnpm eval:feature-matching
 */
import * as fs from 'fs';
import * as path from 'path';
import { generateEmbeddings, toPgVectorLiteral, fromPgVectorLiteral } from '../src/services/embeddings';
import { FeaturesMatchingStrategy } from '../src/utils/matcher';
import { SearchIntent } from '../src/ai';
import { Property } from '../src/services/excel';

interface FeatureMatchingCase {
  id: string;
  requestFeatures: string[];
  propertyFeatures: string;
  expectedSemanticCredit: boolean;
  tags: string[];
}

interface CaseResult {
  id: string;
  tags: string[];
  pass: boolean;
  expected: boolean;
  actual: boolean;
  reason?: string;
}

function loadDataset(): FeatureMatchingCase[] {
  const filePath = path.join(__dirname, 'feature-matching.jsonl');
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function baseRequest(features: string[]): SearchIntent {
  return {
    operation: 'venta', property_type: 'departamento', location_mentions: [], max_budget: null,
    currency: 'USD', bedrooms_min: null, features, country: 'indiferente'
  };
}

function baseProperty(features: string, embedding: number[] | null): Property {
  return {
    address: 'Dirección de prueba', price: 100000, currency: 'USD', bedrooms: 2,
    property_type: 'departamento', operation: 'venta', sheet_name: 'Eval',
    features, features_embedding: embedding
  };
}

async function main(): Promise<void> {
  const dataset = loadDataset();
  console.log(`Corriendo eval de crédito semántico de características: ${dataset.length} casos.\n`);

  // Un embedding por cada lado de cada caso, en un solo batch (mismo criterio que los otros
  // scripts de este directorio — nunca una llamada por caso).
  const texts = dataset.flatMap((c) => [c.requestFeatures.join(', '), c.propertyFeatures]);
  const embeddings = await generateEmbeddings(texts);

  const strategy = new FeaturesMatchingStrategy();
  const results: CaseResult[] = dataset.map((testCase, i) => {
    const requestEmbedding = embeddings[i * 2];
    const propertyEmbedding = fromPgVectorLiteral(toPgVectorLiteral(embeddings[i * 2 + 1]));

    const request = baseRequest(testCase.requestFeatures);
    const property = baseProperty(testCase.propertyFeatures, propertyEmbedding);
    const result = strategy.evaluate(request, property, undefined, requestEmbedding);

    const actual = (result.reason ?? '').includes('semántic');
    return { id: testCase.id, tags: testCase.tags, pass: actual === testCase.expectedSemanticCredit, expected: testCase.expectedSemanticCredit, actual, reason: result.reason };
  });

  const totalPass = results.filter((r) => r.pass).length;
  for (const r of results) {
    console.log(`${r.pass ? '✔' : '✖'} ${r.id} [${r.tags.join(', ')}] esperado=${r.expected} real=${r.actual}`);
  }
  console.log(`\nTotal: ${totalPass}/${results.length}`);

  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(__dirname, 'reports', `${date}-feature-matching.md`);
  const jsonPath = path.join(__dirname, 'reports', `${date}-feature-matching.json`);
  const md = [
    `# Reporte de eval — crédito semántico de características (BE-24/BE-25, EP-07) — ${date}`,
    '',
    'Generado por `pnpm eval:feature-matching` contra `FeaturesMatchingStrategy` real, con',
    'embeddings reales de OpenAI para ambos lados de cada caso.',
    '',
    `**Total: ${totalPass}/${results.length}**`,
    '',
    '| Caso | Tags | Esperado | Real | Resultado |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.tags.join(', ')} | ${r.expected} | ${r.actual} | ${r.pass ? '✅' : '❌'} |`)
  ].join('\n');

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, md);
  fs.writeFileSync(jsonPath, JSON.stringify({ date, totalPass, total: results.length, results }, null, 2));
  console.log(`\nReporte escrito en ${reportPath} y ${jsonPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
