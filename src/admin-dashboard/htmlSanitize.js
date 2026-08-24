// KAN-136: sanitizacion de HTML/atributos del panel admin, extraida a un archivo aparte (mismo
// patron que src/dashboard/ios-onboarding.js, KAN-47) para poder testear las funciones puras con
// node:test sin un DOM real - app.js si depende de document.getElementById de punta a punta y no
// se puede cargar en Node. Se expone como <script> clasico (window.BrokazaHtmlSanitize) y como
// CommonJS (module.exports) para que el mismo archivo sirva tal cual al browser y a los tests.
(function (root) {
  // Reemplazo de caracteres manual (no el truco DOM textContent->innerHTML que usa
  // src/dashboard/app.js) porque el resultado se interpola tanto en texto como dentro de un
  // atributo `title="..."` (ver zoneBadge) - ese truco escapa `&`/`<`/`>` pero NO comillas, asi
  // que un valor con `"` rompería el atributo igual. Escapar tambien `"`/`'` lo hace seguro en
  // ambos contextos.
  function escapeHtml(str) {
    const s = str ?? '';
    return String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function zoneBadge(property) {
    if (property.hasDiscrepancy) {
      const title = `Punto: ${property.zone.name} | Texto sugiere: ${property.textSuggestedZone.name}`;
      return `<span class="badge discrepancy" title="${escapeHtml(title)}">⚠ ${escapeHtml(property.zone.name)}</span>`;
    }
    if (property.zoneSource === 'none') {
      return '<span class="badge none">Sin zona resuelta</span>';
    }
    if (property.zoneSource === 'text') {
      return `<span class="badge text">${escapeHtml(property.zone.name)} (por texto)</span>`;
    }
    return `<span class="badge point">${escapeHtml(property.zone.name)}</span>`;
  }

  const api = { escapeHtml, zoneBadge };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.BrokazaHtmlSanitize = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
