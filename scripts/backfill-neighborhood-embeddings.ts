/**
 * BE-19 (EP-07): genera y persiste el embedding semántico (`neighborhoods.embedding`, BE-18) de
 * cada zona real — nombre normalizado + alias curados (ver `buildNeighborhoodEmbeddingText`,
 * embeddings.ts). Alimenta el fallback semántico de `zonesService.ts` (BE-20) cuando el keyword
 * matching actual no resuelve ninguna mención.
 *
 * NO se ejecuta automáticamente en ningún flujo de la app — hace falta correrlo a mano:
 *   npx ts-node scripts/backfill-neighborhood-embeddings.ts --dry-run   (solo lista qué se embebería)
 *   npx ts-node scripts/backfill-neighborhood-embeddings.ts             (genera y persiste los embeddings reales)
 *   npx ts-node scripts/backfill-neighborhood-embeddings.ts --force     (re-embebe TODAS las zonas, no solo las que tienen embedding NULL)
 *
 * Idempotente por default: sin --force, solo procesa zonas con `embedding IS NULL` — correrlo de
 * nuevo tras agregar una zona nueva (o un alias nuevo a una existente) solo gasta llamadas a la
 * API de embeddings para lo que realmente cambió. Reproducible (no se borra al terminar el
 * ticket) — útil para reembeber tras curar alias nuevos o si se migra a otro modelo de embeddings.
 */
import { supabase } from '../src/services/supabase';
import { logger } from '../src/services/logger';
import { generateEmbeddings, toPgVectorLiteral, buildNeighborhoodEmbeddingText } from '../src/services/embeddings';

// La API de embeddings de OpenAI acepta un array grande en `input`, pero batchear en tandas
// chicas evita un único request gigante (y su timeout) y deja logs de progreso legibles para una
// corrida de ~180 zonas reales.
const BATCH_SIZE = 50;

interface NeighborhoodRow {
  id: string;
  name: string;
  embedding: string | null;
}

async function loadNeighborhoods(force: boolean): Promise<NeighborhoodRow[]> {
  let query = supabase.from('neighborhoods').select('id, name, embedding');
  if (!force) {
    query = query.is('embedding', null);
  }
  const { data, error } = await query;
  if (error) throw new Error(`No se pudieron cargar neighborhoods: ${error.message}`);
  return (data ?? []) as NeighborhoodRow[];
}

async function loadAliasesByNeighborhoodId(): Promise<Map<string, string[]>> {
  const { data, error } = await supabase.from('neighborhood_aliases').select('neighborhood_id, alias');
  if (error) throw new Error(`No se pudieron cargar neighborhood_aliases: ${error.message}`);

  const map = new Map<string, string[]>();
  for (const row of data ?? []) {
    const existing = map.get(row.neighborhood_id) ?? [];
    existing.push(row.alias);
    map.set(row.neighborhood_id, existing);
  }
  return map;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  const [neighborhoods, aliasesByNeighborhoodId] = await Promise.all([
    loadNeighborhoods(force),
    loadAliasesByNeighborhoodId()
  ]);

  if (neighborhoods.length === 0) {
    logger.info('[backfill-neighborhood-embeddings] Nada para procesar — todas las zonas ya tienen embedding (usá --force para reembeber).');
    return;
  }

  logger.info({ total: neighborhoods.length, dryRun, force }, '[backfill-neighborhood-embeddings] Arrancando.');

  let processed = 0;
  for (const batch of chunk(neighborhoods, BATCH_SIZE)) {
    const texts = batch.map((n) => buildNeighborhoodEmbeddingText(n.name, aliasesByNeighborhoodId.get(n.id) ?? []));

    if (dryRun) {
      for (let i = 0; i < batch.length; i++) {
        logger.info({ id: batch[i].id, name: batch[i].name, text: texts[i] }, '[backfill-neighborhood-embeddings] (dry-run) se embebería');
      }
      processed += batch.length;
      continue;
    }

    const embeddings = await generateEmbeddings(texts);

    for (let i = 0; i < batch.length; i++) {
      const { error } = await supabase
        .from('neighborhoods')
        .update({ embedding: toPgVectorLiteral(embeddings[i]) })
        .eq('id', batch[i].id);
      if (error) {
        throw new Error(`No se pudo persistir el embedding de "${batch[i].name}" (${batch[i].id}): ${error.message}`);
      }
    }
    processed += batch.length;
    logger.info({ processed, total: neighborhoods.length }, '[backfill-neighborhood-embeddings] Progreso.');
  }

  logger.info({ processed, dryRun }, '[backfill-neighborhood-embeddings] Listo.');
}

main().catch((error) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, '[backfill-neighborhood-embeddings] Falló.');
  process.exit(1);
});
