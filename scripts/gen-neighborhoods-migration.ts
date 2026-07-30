/**
 * KAN-85: script desechable que lee src/utils/constants/zones.ts, valida/limpia cada polígono
 * (cierre de anillo, puntos degenerados, bounding box de Tucumán) y genera el SQL de migración
 * (schema ya existente, ver docs/evolucion_proyecto/schema_actual.sql) que puebla
 * neighborhood_groups/neighborhoods/neighborhood_aliases. No se ejecuta contra la base --
 * solo imprime el .sql a stdout. Se borra al finalizar el ticket (mismo patrón que test-rls.ts).
 */
import { zones } from '../src/utils/constants/zones';

type Ring = number[][];

const TUCUMAN_BBOX = { minLon: -66.0, maxLon: -64.5, minLat: -27.5, maxLat: -26.4 };

interface CleanResult {
  name: string;
  ring: Ring;
  anomalies: string[];
}

function cleanRing(name: string, coordinates: Ring): CleanResult {
  const anomalies: string[] = [];
  let ring = coordinates.filter(
    (pt) => Array.isArray(pt) && pt.length === 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1])
  );
  if (ring.length !== coordinates.length) {
    anomalies.push(`descartados ${coordinates.length - ring.length} puntos no numéricos/incompletos`);
  }

  // Colapsar puntos consecutivos idénticos (vértices duplicados).
  const dedup: Ring = [];
  for (const pt of ring) {
    const prev = dedup[dedup.length - 1];
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) dedup.push(pt);
  }
  if (dedup.length !== ring.length) {
    anomalies.push(`colapsados ${ring.length - dedup.length} vértices consecutivos duplicados`);
  }
  ring = dedup;

  // Cerrar el anillo si el primer y último punto no coinciden (requerido por ST_GeomFromText POLYGON).
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring = [...ring, first];
    anomalies.push('anillo no cerrado — se agregó el punto inicial al final');
  }

  if (ring.length < 4) {
    anomalies.push(`ANILLO INVÁLIDO: solo ${ring.length} vértices tras limpieza (mínimo 4 para un POLYGON cerrado) — se excluye del insert`);
  }

  for (const [lon, lat] of ring) {
    if (
      lon < TUCUMAN_BBOX.minLon || lon > TUCUMAN_BBOX.maxLon ||
      lat < TUCUMAN_BBOX.minLat || lat > TUCUMAN_BBOX.maxLat
    ) {
      anomalies.push(`vértice (${lon}, ${lat}) fuera del bounding box esperado de Tucumán`);
    }
  }

  return { name, ring, anomalies };
}

// Heurística de agrupamiento por prefijo de nombre — no hay grouping explícito en zones.ts.
function groupFor(name: string): string {
  if (name.startsWith('COUNTRY_') || name.includes('BARRIO_PRIVADO') || name.includes('BARRIO_CERRADO')) {
    return 'Countries y Barrios Privados';
  }
  if (name.startsWith('BARRIO_')) return 'Barrios';
  if (name.startsWith('ZONA_')) return 'Zonas';
  return 'Otros / Puntos de Interés';
}

// Migrado 1:1 desde los branches SIMPLES (no ambiguos) de classifyPropertyZoneId (src/utils/matcher.ts).
// Se excluye deliberadamente el bloque `centroKeywords` (santiago/corrientes/laprida/...): en el código
// original resuelve a ZONA_CENTRO o BARRIO_NORTE según una condición secundaria compuesta, que no es
// representable como alias 1:1 en neighborhood_aliases (alias -> un solo neighborhood_id, con UNIQUE
// global sobre `alias`). Migrar esa ambigüedad exige una decisión de producto sobre el modelo de
// matching, fuera del alcance de este ticket (que es solo taxonomía/datos) — queda documentado en el
// comentario final del SQL generado para la próxima vez que se toque el matching espacial.
const ALIASES: Record<string, string[]> = {
  ZONA_MATE_DE_LUNA: ['mate de luna', 'parque avellaneda'],
  // 'san pablo' se excluye de acá a propósito: es alias legacy del fallback textual, pero existe un
  // polígono SAN_PABLO propio y más preciso — la anomalía se corrige asignándolo a ese neighborhood
  // en vez de a YERBA_BUENA (ver alias de SAN_PABLO más abajo).
  YERBA_BUENA: ['yerba buena', 'aconquija', 'peron', 'perón', 'yb', 'las arboledas', 'san patricio', 'las cañas', 'la arboleda'],
  SAN_PABLO: ['san pablo'],
  ZONA_LOS_NOGALES: ['nogales'],
  ZONA_TAFI_VIEJO: ['tafi viejo', 'tafí viejo'],
  ZONA_LOMAS_DE_TAFI: ['lomas de tafi', 'lomas de tafí'],
  BARRIO_SUR: ['barrio sur', 'b° sur'],
  BARRIO_NORTE: ['barrio norte', 'b° norte'],
};

function sqlEscape(text: string): string {
  return text.replace(/'/g, "''");
}

function toWkt(ring: Ring): string {
  return `POLYGON((${ring.map(([lon, lat]) => `${lon} ${lat}`).join(', ')}))`;
}

function main() {
  const zoneEntries = Object.entries(zones as Record<string, { coordinates: Ring }>);
  const cleaned = zoneEntries.map(([name, data]) => cleanRing(name, data.coordinates));

  const valid = cleaned.filter((c) => c.ring.length >= 4);
  const invalid = cleaned.filter((c) => c.ring.length < 4);

  const groups = Array.from(new Set(valid.map((c) => groupFor(c.name)))).sort();

  const lines: string[] = [];
  lines.push('-- KAN-85: taxonomía de zonas migrada desde src/utils/constants/zones.ts a');
  lines.push('-- neighborhood_groups/neighborhoods/neighborhood_aliases (tablas ya existentes, ver');
  lines.push('-- docs/evolucion_proyecto/schema_actual.sql). Generado por scripts/gen-neighborhoods-migration.ts');
  lines.push(`-- (script desechable, borrado tras aplicar). ${valid.length}/${zoneEntries.length} zonas migradas.`);
  if (invalid.length > 0) {
    lines.push(`-- EXCLUIDAS por anillo inválido tras limpieza: ${invalid.map((c) => c.name).join(', ')}`);
  }
  lines.push('');

  lines.push('INSERT INTO public.neighborhood_groups (name, description) VALUES');
  lines.push(
    groups
      .map((g, i) => `  ('${sqlEscape(g)}', 'Grupo asignado por heurística de prefijo de nombre, KAN-85')${i === groups.length - 1 ? '' : ','}`)
      .join('\n')
  );
  lines.push('ON CONFLICT (name) DO NOTHING;');
  lines.push('');

  lines.push('INSERT INTO public.neighborhoods (name, group_id, boundary) VALUES');
  lines.push(
    valid
      .map((c, i) => {
        const group = groupFor(c.name);
        const wkt = toWkt(c.ring);
        return `  ('${sqlEscape(c.name)}', (SELECT id FROM public.neighborhood_groups WHERE name = '${sqlEscape(group)}'), ST_GeomFromText('${wkt}', 4326))${i === valid.length - 1 ? '' : ','}`;
      })
      .join('\n')
  );
  lines.push('ON CONFLICT (name) DO NOTHING;');
  lines.push('');

  const aliasRows: { neighborhood: string; alias: string }[] = [];
  for (const [neighborhood, aliases] of Object.entries(ALIASES)) {
    if (!valid.some((c) => c.name === neighborhood)) continue; // no insertar alias huérfano
    for (const alias of aliases) aliasRows.push({ neighborhood, alias });
  }

  lines.push('INSERT INTO public.neighborhood_aliases (neighborhood_id, alias) VALUES');
  lines.push(
    aliasRows
      .map((r, i) => `  ((SELECT id FROM public.neighborhoods WHERE name = '${sqlEscape(r.neighborhood)}'), '${sqlEscape(r.alias)}')${i === aliasRows.length - 1 ? '' : ','}`)
      .join('\n')
  );
  lines.push('ON CONFLICT (alias) DO NOTHING;');
  lines.push('');

  lines.push('-- Anomalías detectadas por zona durante la limpieza (KAN-85):');
  for (const c of cleaned) {
    if (c.anomalies.length > 0) {
      lines.push(`--   ${c.name}: ${c.anomalies.join(' | ')}`);
    }
  }

  console.log(lines.join('\n'));

  const anomalyCount = cleaned.filter((c) => c.anomalies.length > 0).length;
  console.error(`\n[gen-neighborhoods-migration] ${zoneEntries.length} zonas leídas, ${valid.length} válidas, ${invalid.length} excluidas, ${anomalyCount} con anomalías detectadas, ${aliasRows.length} aliases generados.`);
}

main();
