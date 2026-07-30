// KAN-78: helpers puros para la persistencia del matching ciego (`blind_matches`, reemplaza a
// `match_queue`). Separado de src/index.ts por el mismo motivo que searchValidation.ts/
// activeSearches.ts (ese archivo arranca el servidor completo al importarse, no se puede importar
// desde tests).

export interface MappedBlindMatch {
  tenant_id: string;
  score: number;
  reasons: string[];
  property: Record<string, unknown>;
}

export interface SearcherSnapshot {
  full_name: string | null;
  phone_number: string | null;
  agency_name: string | null;
}

/**
 * Arma las filas a insertar en blind_matches a partir del shape que ya produce POST /api/search
 * (mappedMatches). Incluye searcher_snapshot en cada fila para que el dueño de la propiedad
 * matcheada (matched_tenant_id) pueda contactar al buscador sin depender de que este último mire
 * a tiempo su propia notificación/email — gap identificado explícitamente en KAN-78.
 */
export function buildBlindMatchInsertRows(
  tenantId: string,
  searchId: string,
  searchText: string,
  searcherSnapshot: SearcherSnapshot,
  mappedMatches: MappedBlindMatch[]
): Record<string, unknown>[] {
  return mappedMatches.map((m) => ({
    tenant_id: tenantId,
    search_id: searchId,
    matched_tenant_id: m.tenant_id,
    raw_search_text: searchText,
    property_snapshot: m.property,
    searcher_snapshot: searcherSnapshot,
    score: m.score,
    reasons: m.reasons || []
  }));
}

/**
 * Mapea una fila de blind_matches al shape que consume el dashboard del lado del BUSCADOR
 * (GET /api/matches). No incluye searcher_snapshot: el buscador no necesita ver sus propios datos.
 */
export function mapBlindMatchRowToDashboardShape(row: any): Record<string, unknown> {
  return {
    id: row.id,
    fecha: new Date(row.created_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' }),
    searchText: row.raw_search_text,
    property: row.property_snapshot,
    reasons: row.reasons || [],
    score: row.score,
    userReviewStatus: row.user_review_status || 'PENDING',
    feedbackReason: row.feedback_reason || null
  };
}

/**
 * Mapea una fila de blind_matches al shape que consume el dashboard del lado del DUEÑO de la
 * propiedad matcheada (GET /api/matches/incoming). Sin userReviewStatus/feedbackReason: esa
 * curación es exclusiva del buscador (POST /api/matches/:id/feedback, tenant_id = auth.uid()).
 */
export function mapIncomingMatchRowToDashboardShape(row: any): Record<string, unknown> {
  return {
    id: row.id,
    fecha: new Date(row.created_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' }),
    searchText: row.raw_search_text,
    searcherContact: row.searcher_snapshot,
    property: row.property_snapshot,
    reasons: row.reasons || [],
    score: row.score
  };
}

/**
 * Agrupa los matches de una búsqueda por tenant_id (dueño de la propiedad matcheada), para poder
 * notificar a cada dueño una sola vez aunque tenga varias propiedades matcheadas en la misma
 * búsqueda.
 */
export function groupMatchesByMatchedTenant(mappedMatches: MappedBlindMatch[]): Record<string, MappedBlindMatch[]> {
  const grouped: Record<string, MappedBlindMatch[]> = {};
  for (const match of mappedMatches) {
    if (!grouped[match.tenant_id]) grouped[match.tenant_id] = [];
    grouped[match.tenant_id].push(match);
  }
  return grouped;
}
