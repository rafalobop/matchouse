import { Property } from './excel';

/**
 * Cachés en memoria por tenant: catálogo de propiedades cargado vía Excel/Sheets, y los últimos
 * matches conocidos (fallback de GET /api/matches si la consulta a match_queue falla).
 *
 * El pipeline de ingesta que antes poblaba `recentMatches` (`handleIncomingMessage`, disparado por
 * mensajes entrantes de WhatsApp/Baileys) se retiró junto con `src/services/whatsapp.ts` — el
 * matching ahora es 100% web vía `active_searches`/`POST /api/search` (`src/services/blindMatching.ts`).
 * `recentMatches` queda como caché vacía y `getRecentMatches` solo se usa como fallback de lectura
 * de `match_queue` (datos históricos de la era WhatsApp).
 */
export class CoordinatorAgent {
  private recentMatches = new Map<string, any[]>();
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

  /**
   * Obtiene los últimos matches registrados en memoria para un tenant
   */
  getRecentMatches(tenantId: string): any[] {
    return this.recentMatches.get(tenantId) || [];
  }
}

export const coordinator = new CoordinatorAgent();
