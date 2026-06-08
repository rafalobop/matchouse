/**
 * Utilidad de filtrado local para determinar si un mensaje de WhatsApp es un pedido
 * de propiedad (demanda) o si es descartable (ofertas, saludos, spam).
 */

const REQUEST_PATTERNS = [
  /\bbusc[oas]\b/i,              // busco, busca, buscas
  /\bbuscamos\b/i,               // buscamos
  /\bbuscan\b/i,                 // buscan
  /\bnecesit[oas]\b/i,           // necesito, necesita, necesitas
  /\bnecesitamos\b/i,            // necesitamos
  /\bnecesitan\b/i,              // necesitan
  /\bcompr[oas]\b/i,             // compro, compra, compras
  /\bcomprari[aa]\b/i,           // compraría
  /\balquilarari[aa]\b/i,        // alquilaría
  /\brequiero\b/i,               // requiero
  /\brequiere\b/i,               // requiere
  /\brequerimiento\b/i,          // requerimiento
  /\breq\b/i,                    // req (abreviación común)
  /\bpedido\b/i,                 // pedido
  /\bbúsqueda\b/i,               // búsqueda (con acento)
  /\bbusqueda\b/i,               // busqueda (sin acento)
  /\bcliente\b/i,                // cliente (ej: "tengo cliente para...")
  /\btenes algo\b/i,             // "tenes algo en..."
  /\balguien tiene\b/i,          // "alguien tiene..."
  /\balgun dato\b/i,             // "algun dato..."
  /\bbuscando\b/i                // buscando
];

// Patrones que típicamente indican una oferta y no un pedido
const OFFER_PATTERNS = [
  /\bofrezco\b/i,
  /\bdisponible\b/i,
  /\bdueño alquila\b/i,
  /\bdueño vende\b/i,
  /\bparticular vende\b/i,
  /\bexcelente oportunidad\b/i,
  /\bpropiedad en venta\b/i
];

/**
 * Determina si el texto del mensaje califica como un pedido/búsqueda de propiedad.
 * @param text Mensaje de WhatsApp entrante
 */
export function isRealEstateRequest(text: string): boolean {
  if (!text || text.trim().length < 10) {
    return false;
  }

  const normalizedText = text.toLowerCase();

  // 1. Debe coincidir con al menos un patrón de búsqueda/pedido
  const matchesRequest = REQUEST_PATTERNS.some(regex => regex.test(normalizedText));
  if (!matchesRequest) {
    return false;
  }

  // 2. Si coincide con una oferta obvia, pero NO contiene "busco" o "necesito", lo filtramos
  const matchesOffer = OFFER_PATTERNS.some(regex => regex.test(normalizedText));
  if (matchesOffer) {
    // Si contiene explícitamente "busco" o "necesito", lo dejamos pasar a pesar del patrón de oferta
    const hasExplicitRequest = /\bbusc[oas]\b/i.test(normalizedText) || /\bnecesit[oas]\b/i.test(normalizedText);
    if (!hasExplicitRequest) {
      return false;
    }
  }

  return true;
}
