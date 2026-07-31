import { Property } from './excel';

/**
 * Caché en memoria por tenant del catálogo de propiedades cargado vía Excel/Sheets.
 *
 * KAN-78: se eliminó `getRecentMatches`/`recentMatches` (Map en memoria que servía de fallback a
 * GET /api/matches si la consulta a `match_queue` fallaba) — era dead code, permanentemente vacío
 * desde que `handleIncomingMessage` (su único escritor, disparado por mensajes entrantes de
 * WhatsApp/Baileys) se retiró junto con `src/services/whatsapp.ts`. `GET /api/matches` ahora lee
 * directo de `blind_matches` y responde 500 real ante un error de DB, en vez de degradar en
 * silencio a una lista vacía.
 */
export class CoordinatorAgent {
  private propertyCatalogs = new Map<string, Property[]>();

  /**
   * Actualiza el catálogo local en memoria utilizado para la comparación de un tenant
   */
  setCatalog(tenantId: string, catalog: Property[]) {
    this.propertyCatalogs.set(tenantId, catalog);
  }

  /**
   * Obtiene el catálogo en memoria de un tenant
   */
  getCatalog(tenantId: string): Property[] {
    return this.propertyCatalogs.get(tenantId) || [];
  }
}

export const coordinator = new CoordinatorAgent();
