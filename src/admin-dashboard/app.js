// Panel admin — vanilla JS, sin build step (mismo criterio que src/dashboard/app.js).

const TUCUMAN_DEFAULT = { lat: -26.8241, lng: -65.2226 };
const METRICS_POLL_MS = 7000;
const PAGE_SIZE = 50;

const state = {
  page: 1,
  search: '',
  total: 0,
  editingPropertyId: null,
  map: null,
  marker: null
};

const el = (id) => document.getElementById(id);

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  let body = null;
  try { body = await res.json(); } catch { /* respuesta sin body */ }
  if (!res.ok) {
    const message = (body && body.error) || `Error ${res.status}`;
    throw new Error(message);
  }
  return body;
}

// --- Login ---

function showLoginView(message, type) {
  el('login-view').classList.remove('hidden');
  el('app-view').classList.add('hidden');
  if (message) {
    el('login-message').textContent = message;
    el('login-message').className = type || '';
  }
}

function showAppView(email) {
  el('login-view').classList.add('hidden');
  el('app-view').classList.remove('hidden');
  el('admin-email-label').textContent = email || '';
  loadMetrics();
  loadProperties();
  startMetricsPolling();
}

el('login-btn').addEventListener('click', async () => {
  const email = el('login-email').value.trim();
  if (!email) return;
  el('login-btn').disabled = true;
  try {
    const res = await apiFetch('/api/auth/request-magic-link', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    el('login-message').textContent = res.message || 'Revisá tu email.';
    el('login-message').className = 'success';
  } catch (err) {
    el('login-message').textContent = err.message;
    el('login-message').className = 'error';
  } finally {
    el('login-btn').disabled = false;
  }
});

el('logout-btn').addEventListener('click', async () => {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  stopMetricsPolling();
  showLoginView();
});

async function handleMagicLinkRedirect() {
  const hash = window.location.hash;
  if (!hash.includes('access_token=')) return false;

  const params = new URLSearchParams(hash.substring(1));
  const access_token = params.get('access_token');
  if (!access_token) return false;

  history.replaceState(null, '', window.location.pathname);

  try {
    const res = await apiFetch('/api/auth/exchange-token', {
      method: 'POST',
      body: JSON.stringify({ access_token })
    });
    showAppView(res.admin && res.admin.email);
    return true;
  } catch (err) {
    showLoginView(err.message, 'error');
    return true;
  }
}

async function checkExistingSession() {
  try {
    const res = await apiFetch('/api/auth/session');
    if (res.authenticated) {
      showAppView(res.admin && res.admin.email);
      return true;
    }
  } catch { /* sesión inválida, mostramos login */ }
  return false;
}

// --- Métricas ---

let metricsInterval = null;

function startMetricsPolling() {
  stopMetricsPolling();
  metricsInterval = setInterval(loadMetrics, METRICS_POLL_MS);
}
function stopMetricsPolling() {
  if (metricsInterval) clearInterval(metricsInterval);
  metricsInterval = null;
}

async function loadMetrics() {
  try {
    const m = await apiFetch('/api/metrics');
    el('metric-matches').textContent = m.totalMatches;
    el('metric-registered').textContent = m.registeredUsers;
    el('metric-active').textContent = m.activeUsers;
    el('metric-active-label').title = m.activeUsersDefinition || '';
    el('metric-properties').textContent = m.totalProperties;
    el('metric-mrr').textContent = m.mrr === null ? 'Pendiente' : m.mrr;
    el('metric-churn').textContent = m.churn === null ? 'Pendiente' : m.churn;
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('403')) {
      stopMetricsPolling();
      showLoginView('Tu sesión expiró. Volvé a ingresar.', 'error');
    }
  }
}

// --- Propiedades ---

function zoneBadge(property) {
  if (property.hasDiscrepancy) {
    return `<span class="badge discrepancy" title="Punto: ${property.zone.name} | Texto sugiere: ${property.textSuggestedZone.name}">⚠ ${escapeHtml(property.zone.name)}</span>`;
  }
  if (property.zoneSource === 'none') {
    return '<span class="badge none">Sin zona resuelta</span>';
  }
  if (property.zoneSource === 'text') {
    return `<span class="badge text">${escapeHtml(property.zone.name)} (por texto)</span>`;
  }
  return `<span class="badge point">${escapeHtml(property.zone.name)}</span>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

async function loadProperties() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.search) params.set('search', state.search);

  try {
    const res = await apiFetch(`/api/properties?${params.toString()}`);
    state.total = res.total;
    renderProperties(res.properties);
    renderPagination();
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('403')) {
      showLoginView('Tu sesión expiró. Volvé a ingresar.', 'error');
    }
  }
}

function renderProperties(properties) {
  const tbody = el('properties-tbody');
  tbody.innerHTML = '';
  for (const p of properties) {
    const tr = document.createElement('tr');
    const coordsText = (p.latitude != null && p.longitude != null)
      ? `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`
      : '(sin coordenadas)';
    tr.innerHTML = `
      <td>${escapeHtml(p.address)}</td>
      <td>${zoneBadge(p)}</td>
      <td>${coordsText}</td>
      <td><button class="edit-btn" data-id="${p.id}">Corregir</button></td>
    `;
    tr.querySelector('.edit-btn').addEventListener('click', () => openCoordModal(p));
    tbody.appendChild(tr);
  }
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  el('page-label').textContent = `Página ${state.page} de ${totalPages}`;
  el('prev-page-btn').disabled = state.page <= 1;
  el('next-page-btn').disabled = state.page >= totalPages;
}

el('prev-page-btn').addEventListener('click', () => {
  if (state.page > 1) { state.page--; loadProperties(); }
});
el('next-page-btn').addEventListener('click', () => {
  state.page++; loadProperties();
});

let searchDebounce = null;
el('property-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.search = e.target.value.trim();
    state.page = 1;
    loadProperties();
  }, 350);
});

// --- Modal de corrección de coordenadas ---

function openCoordModal(property) {
  state.editingPropertyId = property.id;
  el('modal-address').textContent = property.address;
  el('modal-status').textContent = '';
  el('modal-status').className = '';

  const startLat = property.latitude ?? TUCUMAN_DEFAULT.lat;
  const startLng = property.longitude ?? TUCUMAN_DEFAULT.lng;
  el('modal-lat').value = startLat;
  el('modal-lng').value = startLng;

  el('coord-modal').classList.remove('hidden');

  // Leaflet necesita el contenedor visible antes de invalidateSize; se crea una sola vez.
  if (!state.map) {
    state.map = L.map('coord-map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(state.map);
    state.marker = L.marker([startLat, startLng], { draggable: true }).addTo(state.map);
    state.marker.on('dragend', () => {
      const pos = state.marker.getLatLng();
      el('modal-lat').value = pos.lat.toFixed(6);
      el('modal-lng').value = pos.lng.toFixed(6);
    });
    state.map.on('click', (e) => {
      state.marker.setLatLng(e.latlng);
      el('modal-lat').value = e.latlng.lat.toFixed(6);
      el('modal-lng').value = e.latlng.lng.toFixed(6);
    });
  } else {
    state.marker.setLatLng([startLat, startLng]);
  }
  state.map.setView([startLat, startLng], 15);
  setTimeout(() => state.map.invalidateSize(), 50);
}

function closeCoordModal() {
  el('coord-modal').classList.add('hidden');
  state.editingPropertyId = null;
}

el('modal-cancel-btn').addEventListener('click', closeCoordModal);

function syncMarkerFromInputs() {
  const lat = parseFloat(el('modal-lat').value);
  const lng = parseFloat(el('modal-lng').value);
  if (Number.isFinite(lat) && Number.isFinite(lng) && state.marker) {
    state.marker.setLatLng([lat, lng]);
    state.map.panTo([lat, lng]);
  }
}
el('modal-lat').addEventListener('change', syncMarkerFromInputs);
el('modal-lng').addEventListener('change', syncMarkerFromInputs);

el('modal-save-btn').addEventListener('click', async () => {
  const lat = parseFloat(el('modal-lat').value);
  const lng = parseFloat(el('modal-lng').value);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    el('modal-status').textContent = 'Latitud/longitud fuera de rango.';
    el('modal-status').className = 'error';
    return;
  }

  el('modal-save-btn').disabled = true;
  try {
    await apiFetch(`/api/properties/${state.editingPropertyId}/coordinates`, {
      method: 'PATCH',
      body: JSON.stringify({ latitude: lat, longitude: lng })
    });
    el('modal-status').textContent = 'Guardado.';
    el('modal-status').className = 'success';
    await loadProperties();
    setTimeout(closeCoordModal, 600);
  } catch (err) {
    el('modal-status').textContent = err.message;
    el('modal-status').className = 'error';
  } finally {
    el('modal-save-btn').disabled = false;
  }
});

// --- Init ---

(async function init() {
  const handledRedirect = await handleMagicLinkRedirect();
  if (!handledRedirect) {
    await checkExistingSession();
  }
})();
