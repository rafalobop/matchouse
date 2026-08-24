/**
 * KAN-130: completa `properties.zone_id` para las filas que la migración SQL
 * (backfill_properties_zone_id_spatial/_nearby) no pudo resolver por punto — sin `location`, o con
 * `location` pero sin ninguna zona a menos de 150m. Usa exactamente la misma heurística de texto
 * que ya aplica `resolvePropertyZoneInfo` en runtime (dirección + features + hoja), así que el
 * resultado es idéntico al que vería un operador del panel admin hoy — esto solo lo persiste en la
 * columna para que quede cacheado de una.
 *
 * Reusable: no es un script de un solo uso — si en el futuro se suben propiedades por Excel sin
 * pasar por una corrección de coordenadas en el panel admin, correr esto de nuevo backfillea las
 * que hayan quedado con zone_id NULL.
 *
 * Uso: npx ts-node scripts/backfill-properties-zone-id.ts
 */
import { supabase } from '../src/services/supabase';
import { resolveNeighborhoodIdByText } from '../src/services/zonesService';

interface Row {
  id: string;
  address: string;
  sheet_name: string;
  features: string | null;
}

async function main() {
  const { data, error } = await supabase
    .from('properties')
    .select('id, address, sheet_name, features')
    .is('zone_id', null);

  if (error) {
    console.error('Error trayendo propiedades sin zone_id:', error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as Row[];
  console.log(`Propiedades sin zone_id: ${rows.length}`);

  let resolved = 0;
  let unresolved = 0;

  for (const p of rows) {
    const text = `${p.address} ${p.features ?? ''} ${p.sheet_name}`;
    const neighborhoodId = await resolveNeighborhoodIdByText(text);

    if (!neighborhoodId) {
      unresolved++;
      continue;
    }

    const { error: updateError } = await supabase
      .from('properties')
      .update({ zone_id: neighborhoodId })
      .eq('id', p.id);

    if (updateError) {
      console.error(`  Error actualizando ${p.id}:`, updateError.message);
      continue;
    }
    resolved++;
  }

  console.log(`Resueltas por texto y persistidas: ${resolved}`);
  console.log(`Sin ninguna zona resoluble (ni punto ni texto) — quedan con zone_id NULL: ${unresolved}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
