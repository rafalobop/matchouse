/**
 * Script de diagnóstico (desechable): corre resolvePropertyZoneInfo() real contra TODAS las
 * propiedades con lat/lng en la base, y reporta si cada una resolvió su zona por PUNTO
 * (PostGIS, preciso) o si tuvo que caer al fallback de TEXTO (menos confiable). También
 * marca discrepancias: casos donde el texto (dirección/features/sheet_name) sugiere una zona
 * distinta a la resuelta por punto, que es la señal de "el excel dice una zona pero las
 * coordenadas dicen otra".
 */
import { supabase } from '../src/services/supabase';
import { resolvePropertyZoneInfo } from '../src/services/zonesService';

interface Row {
  id: string;
  address: string;
  sheet_name: string;
  features: string | null;
  latitude: number | null;
  longitude: number | null;
  tenant_id: string;
}

async function main() {
  const { data, error } = await supabase
    .from('properties')
    .select('id, address, sheet_name, features, latitude, longitude, tenant_id')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);

  if (error) {
    console.error('Error trayendo propiedades:', error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as Row[];

  let byPoint = 0;
  let byTextFallback = 0;
  let unresolved = 0;
  const discrepancies: { address: string; pointZone: string; textZone: string }[] = [];
  const fallbackRows: { address: string; lat: number; lon: number; textZone: string | null }[] = [];
  const unresolvedRows: { address: string; lat: number; lon: number }[] = [];

  for (const p of rows) {
    const info = await resolvePropertyZoneInfo({
      latitude: p.latitude,
      longitude: p.longitude,
      address: p.address,
      features: p.features ?? undefined,
      sheet_name: p.sheet_name
    });

    if (info.source === 'point') {
      byPoint++;
      if (info.hasDiscrepancy) {
        discrepancies.push({
          address: p.address,
          pointZone: info.zone!.name,
          textZone: info.textSuggestedZone?.name ?? '(desconocida)'
        });
      }
    } else if (info.source === 'text') {
      byTextFallback++;
      fallbackRows.push({ address: p.address, lat: p.latitude!, lon: p.longitude!, textZone: info.zone?.name ?? null });
    } else {
      unresolved++;
      unresolvedRows.push({ address: p.address, lat: p.latitude!, lon: p.longitude! });
    }
  }

  console.log(`\nTotal propiedades con coordenadas: ${rows.length}`);
  console.log(`  Resueltas por PUNTO (preciso, PostGIS):        ${byPoint}`);
  console.log(`  Resueltas por FALLBACK de TEXTO (punto falló): ${byTextFallback}`);
  console.log(`  Sin ninguna zona resuelta:                     ${unresolved}`);

  if (discrepancies.length > 0) {
    console.log(`\n⚠️  Discrepancias punto vs texto (punto ganó, pero el texto sugería otra zona) — ${discrepancies.length}:`);
    for (const d of discrepancies) {
      console.log(`  - "${d.address}": punto -> ${d.pointZone} | texto sugería -> ${d.textZone}`);
    }
  } else {
    console.log('\nSin discrepancias punto vs texto en los casos donde el punto resolvió.');
  }

  if (fallbackRows.length > 0) {
    console.log(`\n⚠️  Propiedades que tuvieron que caer a TEXTO (el punto no cayó en ningún polígono / a <150m) — ${fallbackRows.length}:`);
    for (const f of fallbackRows) {
      console.log(`  - "${f.address}" (${f.lat}, ${f.lon}) -> zona por texto: ${f.textZone ?? '(ninguna)'}`);
    }
  }

  if (unresolvedRows.length > 0) {
    console.log(`\n⚠️  Propiedades SIN NINGUNA zona resuelta (ni punto ni texto) — ${unresolvedRows.length}:`);
    for (const u of unresolvedRows.slice(0, 15)) {
      console.log(`  - "${u.address}" (${u.lat}, ${u.lon})`);
    }
    if (unresolvedRows.length > 15) console.log(`  ... y ${unresolvedRows.length - 15} más.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
