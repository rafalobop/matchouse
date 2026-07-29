// Elementos del DOM - Sesión / Header
const tenantSession = document.getElementById('tenant-session');
const tenantEmailText = document.getElementById('tenant-email-text');
const logoutBtn = document.getElementById('logout-btn');
const logoutBtnLabel = document.getElementById('logout-btn-label');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadTriggerBtn = document.getElementById('upload-trigger-btn');
const uploadStatus = document.getElementById('upload-status');
const propertiesCount = document.getElementById('properties-count');

const matchesList = document.getElementById('matches-list');

// Elementos del DOM - Mis Búsquedas Activas
const activeSearchesList = document.getElementById('active-searches-list');
const searchTextInput = document.getElementById('search-text-input');
const searchCharCounter = document.getElementById('search-char-counter');
const submitSearchBtn = document.getElementById('submit-search-btn');
const searchFormStatus = document.getElementById('search-form-status');

// Elementos del DOM - Auth Magic Link
const authOverlay = document.getElementById('auth-overlay');
const authCardStep1 = document.getElementById('auth-card-step1');
const authCardStep2 = document.getElementById('auth-card-step2');
const authEmailInput = document.getElementById('auth-email-input');
const authSendMagicLinkBtn = document.getElementById('auth-send-magic-link-btn');
const authBackBtn = document.getElementById('auth-back-btn');
const authStep1Error = document.getElementById('auth-step1-error');
const authStep2Error = document.getElementById('auth-step2-error');

// ==========================================
// TEMA (CLARO / OSCURO)
// ==========================================

const THEME_STORAGE_KEY = 'matchouse-theme';
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeIconDark = document.getElementById('theme-icon-dark');
const themeIconLight = document.getElementById('theme-icon-light');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (themeIconDark && themeIconLight) {
    themeIconDark.classList.toggle('hidden', theme === 'dark');
    themeIconLight.classList.toggle('hidden', theme !== 'dark');
  }
}

function initTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  applyTheme(stored === 'dark' ? 'dark' : 'light');
}

if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  });
}

initTheme();

/**
 * fetch con timeout: evita spinners infinitos cuando el servidor no responde
 * y loguea en consola el motivo real del fallo (timeout vs. red vs. HTTP) para diagnóstico.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000, logTag = '[AUTH]') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`${logTag} Timeout de ${timeoutMs}ms esperando respuesta de ${url}`);
      throw new Error('El servidor no respondió a tiempo. Probá de nuevo en unos segundos.');
    }
    console.error(`${logTag} Error de red al conectar con ${url}:`, error.name, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Estado de Autenticación
let matchesInterval = null;
let catalogInterval = null;
let activeSearchesInterval = null;
let isUserAuthenticated = false;
let currentTenantInfo = null;

// Interceptor Global de Fetch para desloguear ante error 401 (Sesión Única Estricta)
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  const response = await originalFetch(...args);
  if (response.status === 401) {
    if (isUserAuthenticated) {
      isUserAuthenticated = false;
      currentTenantInfo = null;
      const btnPushSubscribe = document.getElementById('btn-push-subscribe');
      if (btnPushSubscribe) btnPushSubscribe.classList.add('hidden');
      updateTenantSessionUI();
      authOverlay.classList.remove('hidden');
      resetAuthCards();
      stopDashboardPolling();
    }
  }
  return response;
};

// ==========================================
// CONTROL DE POLLES Y SESIÓN (AUTH)
// ==========================================

function resetAuthCards() {
  authCardStep2.classList.add('hidden');
  authCardStep1.classList.remove('hidden');
  hideAuthError(authStep1Error);
  hideAuthError(authStep2Error);
  if (authEmailInput) authEmailInput.value = '';
}

function updateTenantSessionUI() {
  if (isUserAuthenticated && currentTenantInfo) {
    tenantEmailText.innerText = currentTenantInfo.email || '';
    tenantSession.classList.remove('hidden');
  } else {
    tenantSession.classList.add('hidden');
  }
}

async function checkAuthSession() {
  try {
    const res = await fetchWithTimeout('/api/auth/session');
    if (!res.ok) {
      console.error('[AUTH] /api/auth/session respondió con error HTTP', res.status);
    }
    const data = await res.json();

    if (data.authenticated) {
      currentTenantInfo = data.tenant;
      isUserAuthenticated = true;
      authOverlay.classList.add('hidden');
      updateTenantSessionUI();
      startDashboardPolling();
    } else {
      isUserAuthenticated = false;
      currentTenantInfo = null;
      updateTenantSessionUI();
      authOverlay.classList.remove('hidden');
      resetAuthCards();
      stopDashboardPolling();
    }
  } catch (error) {
    console.error('[AUTH] Error al comprobar sesión auth:', error.message);
  }
}

// Detectar magic link en el hash de la URL al cargar la página
async function handleMagicLinkCallback() {
  const hash = window.location.hash;
  if (!hash.includes('access_token=')) return false;

  const params = new URLSearchParams(hash.substring(1));
  const access_token = params.get('access_token');
  if (!access_token) return false;

  // Limpiar el hash de la URL sin recargar
  history.replaceState(null, '', window.location.pathname);

  console.log('[AUTH] Magic link callback detectado, intercambiando token...');
  try {
    const res = await fetchWithTimeout('/api/auth/exchange-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token })
    });
    if (!res.ok) {
      const data = await res.json();
      console.error('[AUTH] Error al intercambiar token:', res.status, data.error);
    } else {
      console.log('[AUTH] Token intercambiado correctamente, sesión iniciada.');
    }
  } catch (error) {
    console.error('[AUTH] Fallo al intercambiar token:', error.message);
  }
  return true;
}

// Detectar error de magic link (ej. link expirado o ya usado) en el hash de la URL al cargar la página
function handleAuthErrorCallback() {
  const hash = window.location.hash;
  if (!hash.includes('error=')) return false;

  const params = new URLSearchParams(hash.substring(1));
  const errorCode = params.get('error_code');
  const errorDescription = params.get('error_description');

  // Limpiar el hash de la URL sin recargar
  history.replaceState(null, '', window.location.pathname);

  console.warn('[AUTH] El link de acceso llegó con un error:', errorCode, errorDescription);

  const message = errorCode === 'otp_expired'
    ? 'Tu link de acceso expiró o ya fue usado. Ingresá tu email para solicitar uno nuevo.'
    : 'El link de acceso no es válido. Ingresá tu email para solicitar uno nuevo.';

  authOverlay.classList.remove('hidden');
  authCardStep2.classList.add('hidden');
  authCardStep1.classList.remove('hidden');
  showAuthError(authStep1Error, message);
  return true;
}

function startDashboardPolling() {
  if (matchesInterval) return; // Ya está corriendo

  loadCatalogInfo();
  loadMatches();
  loadActiveSearches();

  matchesInterval = setInterval(loadMatches, 2000);
  catalogInterval = setInterval(loadCatalogInfo, 5000);
  activeSearchesInterval = setInterval(loadActiveSearches, 10000);
}

function stopDashboardPolling() {
  if (matchesInterval) {
    clearInterval(matchesInterval);
    matchesInterval = null;
  }
  if (catalogInterval) {
    clearInterval(catalogInterval);
    catalogInterval = null;
  }
  if (activeSearchesInterval) {
    clearInterval(activeSearchesInterval);
    activeSearchesInterval = null;
  }
}

// Handlers de Auth Magic Link
authSendMagicLinkBtn.addEventListener('click', async () => {
  const email = authEmailInput.value.trim();
  if (!email || !email.includes('@')) {
    showAuthError(authStep1Error, 'Ingresá un email válido.');
    return;
  }

  authSendMagicLinkBtn.disabled = true;
  authSendMagicLinkBtn.innerText = 'Enviando...';
  hideAuthError(authStep1Error);

  console.log('[AUTH] Solicitando magic link para', email);
  try {
    const res = await fetchWithTimeout('/api/auth/request-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await res.json();
    if (res.ok) {
      console.log('[AUTH] Magic link enviado, esperando click del usuario en el email.');
      authCardStep1.classList.add('hidden');
      authCardStep2.classList.remove('hidden');
    } else {
      console.error('[AUTH] El servidor rechazó la solicitud de magic link:', res.status, data.error);
      showAuthError(authStep1Error, data.error || 'Error al enviar el magic link.');
    }
  } catch (error) {
    console.error('[AUTH] Fallo al solicitar magic link:', error.name, error.message);
    showAuthError(authStep1Error, error.message || 'Error de red al conectar con el servidor.');
  } finally {
    authSendMagicLinkBtn.disabled = false;
    authSendMagicLinkBtn.innerText = 'Enviar Magic Link';
  }
});

authBackBtn.addEventListener('click', () => {
  authCardStep2.classList.add('hidden');
  authCardStep1.classList.remove('hidden');
  hideAuthError(authStep2Error);
});

function showAuthError(element, msg) {
  element.innerText = msg;
  element.style.display = 'block';
}

function hideAuthError(element) {
  element.style.display = 'none';
}

// ==========================================
// INVENTARIO DE PROPIEDADES
// ==========================================

async function loadCatalogInfo() {
  try {
    const res = await fetch('/api/catalog');
    const data = await res.json();
    propertiesCount.innerText = data.count || '0';
  } catch (error) {
    console.error('Error al cargar info de catálogo:', error);
  }
}

dropzone.addEventListener('click', (e) => {
  if (e.target === uploadTriggerBtn) return; // el botón ya abre el picker por su propio listener
  fileInput.click();
});
uploadTriggerBtn.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFileUpload(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleFileUpload(fileInput.files[0]);
  }
});

async function handleFileUpload(file) {
  if (!file.name.endsWith('.xlsx')) {
    showUploadStatus('Error: Solo se permiten archivos Excel (.xlsx)', 'error');
    return;
  }

  showUploadStatus('Subiendo y procesando archivo...', '');

  const formData = new FormData();
  formData.append('excelFile', file);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (res.ok) {
      showUploadStatus(`¡Éxito! Se cargaron ${data.count} propiedades.`, 'success');
      loadCatalogInfo();
    } else {
      showUploadStatus(`Error: ${data.error || 'No se pudo procesar el archivo.'}`, 'error');
    }
  } catch (error) {
    console.error(error);
    showUploadStatus('Error de red al subir archivo.', 'error');
  }
}

function showUploadStatus(msg, type) {
  uploadStatus.innerText = msg;
  uploadStatus.className = 'status-msg';
  if (type) {
    uploadStatus.classList.add(type);
  } else {
    uploadStatus.classList.add('hidden');
  }

  if (type === 'success') {
    setTimeout(() => {
      uploadStatus.classList.add('hidden');
    }, 5000);
  }
}

// ==========================================
// ÚLTIMOS MATCHES (acordeón)
// ==========================================

// Variables de paginación y ordenación para matches
let currentPage = 1;
const pageSize = 10;
let sortOption = 'fecha-desc';

function getScore(match) {
  const m = match.matchDetails.match(/Score:\s*(\d+)%/i);
  return m ? parseInt(m[1], 10) : 0;
}

async function loadMatches() {
  try {
    const res = await fetch('/api/matches');
    const data = await res.json();

    const matches = data.matches || [];

    if (matches.length === 0) {
      matchesList.innerHTML = '<p class="table-placeholder">No se han registrado matches en esta sesión.</p>';
      document.getElementById('page-start').innerText = '0';
      document.getElementById('page-end').innerText = '0';
      document.getElementById('total-matches').innerText = '0';
      document.getElementById('current-page-text').innerText = 'Pág. 1 de 1';
      document.getElementById('prev-page-btn').disabled = true;
      document.getElementById('next-page-btn').disabled = true;
      return;
    }

    let matchesToSort = [...matches];

    if (sortOption === 'fecha-desc') {
      // Orden nativo
    } else if (sortOption === 'fecha-asc') {
      matchesToSort.reverse();
    } else if (sortOption === 'score-desc') {
      matchesToSort.sort((a, b) => getScore(b) - getScore(a));
    } else if (sortOption === 'score-asc') {
      matchesToSort.sort((a, b) => getScore(a) - getScore(b));
    }

    const totalMatches = matchesToSort.length;
    const totalPages = Math.ceil(totalMatches / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalMatches);
    const paginatedMatches = matchesToSort.slice(startIndex, endIndex);

    document.getElementById('page-start').innerText = totalMatches > 0 ? startIndex + 1 : 0;
    document.getElementById('page-end').innerText = endIndex;
    document.getElementById('total-matches').innerText = totalMatches;
    document.getElementById('current-page-text').innerText = `Pág. ${currentPage} de ${totalPages}`;
    document.getElementById('prev-page-btn').disabled = currentPage <= 1;
    document.getElementById('next-page-btn').disabled = currentPage >= totalPages;

    matchesList.innerHTML = '';
    paginatedMatches.forEach(m => {
      matchesList.appendChild(buildMatchItem(m));
    });
  } catch (error) {
    console.error('Error al cargar historial de matches:', error);
  }
}

function buildMatchItem(m) {
  const details = document.createElement('details');
  details.className = 'match-item';
  if (m.userReviewStatus === 'ACCEPTED') details.classList.add('match-accepted');
  if (m.userReviewStatus === 'REJECTED') details.classList.add('match-rejected');

  const summary = document.createElement('summary');
  summary.className = 'match-summary';

  let statusBadgeHtml = '<span class="curation-badge pending">Pendiente</span>';
  if (m.userReviewStatus === 'ACCEPTED') {
    statusBadgeHtml = '<span class="curation-badge accepted">Aceptado</span>';
  } else if (m.userReviewStatus === 'REJECTED') {
    statusBadgeHtml = '<span class="curation-badge rejected">Rechazado</span>';
  }

  summary.innerHTML = `
    <div class="match-summary-main">
      <strong>${m.property.domicilio}</strong>
      <span class="match-summary-price">${m.property.moneda} ${m.property.precio} (${m.property.operacion})</span>
    </div>
    <div class="match-summary-meta">
      <span class="match-summary-date">${m.fecha}</span>
      <span class="match-group-tag">${m.groupName || 'Grupo Desconocido'}</span>
      ${statusBadgeHtml}
    </div>
  `;

  const body = document.createElement('div');
  body.className = 'match-body';

  const tdPedido = document.createElement('p');
  tdPedido.className = 'match-original-text';
  tdPedido.innerText = `"${m.originalText}"`;

  const tdSolicitante = document.createElement('p');
  let contactHtml = m.contactSender;
  const matchNumber = m.contactSender.match(/@(\d+)/);
  if (matchNumber) {
    const phone = matchNumber[1];
    const name = m.contactSender.replace(`@${phone}`, '').replace(/[()]/g, '').trim();
    contactHtml = `<a href="https://wa.me/${phone}" target="_blank" class="contact-link" title="Contactar por WhatsApp" style="color: #25d366; text-decoration: none; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display: inline-block; vertical-align: middle;"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.724-1.455L0 24zm6.59-4.846c1.6.95 3.488 1.459 5.407 1.461 5.485.002 9.948-4.41 9.952-9.863.002-2.643-1.027-5.127-2.9-7c-1.873-1.873-4.365-2.905-7.008-2.906-5.485 0-9.94 4.41-9.947 9.86-.002 1.964.512 3.88 1.49 5.59L1.657 21.8l6.088-1.597c.001-.001.001-.001.002-.001zm10.182-7.872c-.299-.149-1.771-.875-2.045-.974-.275-.098-.476-.149-.675.149-.199.299-.771.974-.946 1.173-.174.199-.349.224-.648.075-1.137-.57-1.9-.943-2.654-2.24-.199-.349-.199-.567-.05-.716.134-.134.299-.349.448-.523.149-.174.199-.299.299-.497.099-.199.049-.373-.025-.522-.075-.149-.675-1.628-.925-2.227-.243-.584-.489-.505-.675-.514-.175-.008-.375-.01-.575-.01-.199 0-.523.075-.797.373-.274.299-1.047 1.022-1.047 2.49 0 1.468 1.069 2.887 1.219 3.086.149.199 2.099 3.205 5.087 4.496.71.307 1.265.49 1.696.627.713.227 1.362.195 1.875.118.571-.085 1.771-.724 2.02-1.42.249-.697.249-1.295.174-1.42-.075-.125-.274-.199-.573-.349z"/></svg>
       @${phone}
     </a> (${name})`;
  }
  tdSolicitante.innerHTML = `<strong>Solicitante:</strong> ${contactHtml}`;

  const divDetails = document.createElement('div');
  divDetails.className = 'match-reasons';
  divDetails.innerText = m.matchDetails;

  body.appendChild(tdPedido);
  body.appendChild(tdSolicitante);
  body.appendChild(divDetails);

  if (m.userReviewStatus === 'REJECTED') {
    const reasonP = document.createElement('p');
    reasonP.className = 'curation-reason-text';
    reasonP.innerText = `Motivo: ${m.feedbackReason || 'No especificado'}`;
    body.appendChild(reasonP);
  } else if (!m.userReviewStatus || m.userReviewStatus === 'PENDING') {
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'curation-actions-container';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'btn btn-success btn-small';
    acceptBtn.innerText = 'Aceptar';
    acceptBtn.addEventListener('click', (e) => { e.preventDefault(); sendFeedback(m.id, 'ACCEPTED'); });

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-danger btn-small';
    rejectBtn.innerText = 'Rechazar';
    rejectBtn.addEventListener('click', (e) => { e.preventDefault(); openRejectionModal(m.id); });

    actionsDiv.appendChild(acceptBtn);
    actionsDiv.appendChild(rejectBtn);
    body.appendChild(actionsDiv);
  }

  details.appendChild(summary);
  details.appendChild(body);
  return details;
}

// ==========================================
// MIS BÚSQUEDAS ACTIVAS (MATCHING CIEGO - KAN-42/KAN-43)
// ==========================================

const SEARCH_STATUS_LABELS = {
  active: 'Activa',
  expired: 'Vencida',
  matched: 'Con match confirmado',
  cancelled: 'Cancelada'
};

const OPERATION_LABELS = {
  venta: 'Venta',
  alquiler: 'Alquiler',
  desconocido: 'Operación sin especificar'
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}

function buildSearchSummary(criteria) {
  if (!criteria) return 'Búsqueda sin criterios detectados.';

  const parts = [];
  parts.push(OPERATION_LABELS[criteria.operation] || 'Operación sin especificar');

  if (criteria.property_type) parts.push(criteria.property_type);
  if (Array.isArray(criteria.zones) && criteria.zones.length > 0) parts.push(`en ${criteria.zones.join(', ')}`);
  if (criteria.bedrooms) parts.push(`${criteria.bedrooms} dorm.`);
  if (criteria.max_budget && criteria.currency && criteria.currency !== 'desconocido') {
    parts.push(`hasta ${criteria.currency} ${criteria.max_budget}`);
  }

  return parts.join(' · ');
}

// Formulario de nueva búsqueda (KAN-43). Mismo límite de caracteres de control que
// src/utils/searchValidation.ts en el backend (\n y \r permitidos, el resto no) — se filtra en
// vivo para que el usuario nunca llegue a intentar enviar algo que el backend va a rechazar.
const MAX_SEARCH_TEXT_LENGTH = 200;
const SEARCH_CONTROL_CHARS_REGEX = /[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g;

function showSearchFormStatus(msg, type) {
  if (!searchFormStatus) return;
  searchFormStatus.innerText = msg;
  searchFormStatus.className = 'status-msg';
  if (type) searchFormStatus.classList.add(type);
}

function updateSearchCharCounter() {
  if (!searchTextInput || !searchCharCounter) return;
  const length = searchTextInput.value.length;
  searchCharCounter.innerText = `${length}/${MAX_SEARCH_TEXT_LENGTH}`;
  searchCharCounter.classList.toggle('limit-reached', length >= MAX_SEARCH_TEXT_LENGTH);
}

if (searchTextInput) {
  searchTextInput.addEventListener('input', () => {
    const cleaned = searchTextInput.value.replace(SEARCH_CONTROL_CHARS_REGEX, '');
    if (cleaned !== searchTextInput.value) {
      const cursor = Math.min(searchTextInput.selectionStart, cleaned.length);
      searchTextInput.value = cleaned;
      searchTextInput.setSelectionRange(cursor, cursor);
    }
    updateSearchCharCounter();
  });
}

if (submitSearchBtn) {
  submitSearchBtn.addEventListener('click', async () => {
    const text = searchTextInput.value.trim();

    if (!text) {
      showSearchFormStatus('Escribí qué estás buscando antes de guardar.', 'error');
      return;
    }

    submitSearchBtn.disabled = true;
    submitSearchBtn.innerText = 'Buscando...';
    showSearchFormStatus('Procesando tu búsqueda...', '');

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      const data = await res.json();

      if (res.ok) {
        showSearchFormStatus('¡Búsqueda guardada! Ya aparece en "Mis búsquedas activas".', 'success');
        searchTextInput.value = '';
        updateSearchCharCounter();
        loadActiveSearches();
        setTimeout(() => searchFormStatus.classList.add('hidden'), 4000);
      } else {
        showSearchFormStatus(data.error || 'No se pudo guardar la búsqueda.', 'error');
      }
    } catch (error) {
      console.error('Error al enviar la búsqueda:', error);
      showSearchFormStatus('Error de red al enviar la búsqueda.', 'error');
    } finally {
      submitSearchBtn.disabled = false;
      submitSearchBtn.innerText = 'Buscar';
    }
  });
}

async function loadActiveSearches() {
  if (!activeSearchesList) return;

  try {
    const res = await fetch('/api/searches');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const searches = data.searches || [];

    if (searches.length === 0) {
      activeSearchesList.innerHTML = '<p class="list-placeholder">No tenés búsquedas activas en este momento.</p>';
      return;
    }

    activeSearchesList.innerHTML = '';
    searches.forEach(search => {
      activeSearchesList.appendChild(buildActiveSearchItem(search));
    });
  } catch (error) {
    console.error('Error al cargar búsquedas activas:', error);
    activeSearchesList.innerHTML = '<p class="list-placeholder error">Error al obtener tus búsquedas activas.</p>';
  }
}

function buildActiveSearchItem(search) {
  const item = document.createElement('div');
  item.className = 'active-search-item';

  const statusKey = search.status || 'active';
  const statusLabel = SEARCH_STATUS_LABELS[statusKey] || statusKey;
  const isUrgent = statusKey === 'active' && search.days_remaining <= 2;
  const isExpired = statusKey === 'expired';

  item.innerHTML = `
    <div class="active-search-summary">${escapeHtml(buildSearchSummary(search.criteria))}</div>
    <div class="active-search-raw-text">"${escapeHtml(search.raw_text)}"</div>
    <div class="active-search-badges">
      <span class="search-badge status-${statusKey}">${escapeHtml(statusLabel)}</span>
      <span class="search-badge matches-count">${search.matches_count} match${search.matches_count === 1 ? '' : 'es'}</span>
      ${isExpired
        ? ''
        : `<span class="search-badge days-remaining${isUrgent ? ' urgent' : ''}">${search.days_remaining} día${search.days_remaining === 1 ? '' : 's'} restante${search.days_remaining === 1 ? '' : 's'}</span>`}
    </div>
  `;

  const actions = document.createElement('div');
  actions.className = 'active-search-actions';

  if (isExpired) {
    const reactivateBtn = document.createElement('button');
    reactivateBtn.className = 'btn btn-success btn-small';
    reactivateBtn.innerText = 'Reactivar';
    reactivateBtn.addEventListener('click', () => reactivateSearch(search.id, reactivateBtn));
    actions.appendChild(reactivateBtn);
  }

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'btn btn-danger btn-small';
  archiveBtn.innerText = 'Archivar';
  archiveBtn.addEventListener('click', () => archiveSearch(search.id, archiveBtn));
  actions.appendChild(archiveBtn);

  item.appendChild(actions);
  return item;
}

async function archiveSearch(searchId, triggerBtn) {
  if (!confirm('¿Archivar esta búsqueda? Dejará de aparecer en tus búsquedas activas.')) return;

  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const res = await fetch(`/api/searches/${searchId}`, { method: 'DELETE' });
    if (res.ok) {
      loadActiveSearches();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'No se pudo archivar la búsqueda.');
      if (triggerBtn) triggerBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error al archivar la búsqueda:', error);
    alert('Error de red al archivar la búsqueda.');
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

async function reactivateSearch(searchId, triggerBtn) {
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const res = await fetch(`/api/searches/${searchId}/reactivate`, { method: 'POST' });
    if (res.ok) {
      loadActiveSearches();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'No se pudo reactivar la búsqueda.');
      if (triggerBtn) triggerBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error al reactivar la búsqueda:', error);
    alert('Error de red al reactivar la búsqueda.');
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

document.getElementById('sort-select').addEventListener('change', (e) => {
  sortOption = e.target.value;
  currentPage = 1;
  loadMatches();
});

document.getElementById('prev-page-btn').addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    loadMatches();
  }
});

document.getElementById('next-page-btn').addEventListener('click', () => {
  currentPage++;
  loadMatches();
});

// Variables de Modal de Rechazo
let currentCurationMatchId = null;
const rejectionModal = document.getElementById('rejection-modal');
const confirmRejectBtn = document.getElementById('confirm-reject-btn');
const cancelRejectBtn = document.getElementById('cancel-reject-btn');
const manualReasonContainer = document.getElementById('manual-reason-container');
const manualReasonInput = document.getElementById('manual-reason-input');

document.querySelectorAll('input[name="rejection-reason"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    if (e.target.value === 'otro') {
      manualReasonContainer.classList.remove('hidden');
    } else {
      manualReasonContainer.classList.add('hidden');
    }
  });
});

async function sendFeedback(matchId, status, reason = null) {
  try {
    const res = await fetch(`/api/matches/${matchId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason })
    });
    if (res.ok) {
      loadMatches();
    } else {
      alert('Error al guardar feedback del match.');
    }
  } catch (error) {
    console.error('Error al enviar feedback:', error);
  }
}

function openRejectionModal(matchId) {
  currentCurationMatchId = matchId;
  manualReasonInput.value = '';
  manualReasonContainer.classList.add('hidden');
  document.querySelector('input[name="rejection-reason"][value="mal_filtrado"]').checked = true;
  rejectionModal.classList.remove('hidden');
}

cancelRejectBtn.addEventListener('click', () => {
  rejectionModal.classList.add('hidden');
  currentCurationMatchId = null;
});

confirmRejectBtn.addEventListener('click', async () => {
  if (!currentCurationMatchId) return;
  const selectedRadio = document.querySelector('input[name="rejection-reason"]:checked');
  let reason = '';
  if (selectedRadio.value === 'otro') {
    reason = manualReasonInput.value.trim() || 'Otro motivo';
  } else {
    reason = selectedRadio.nextElementSibling.innerText;
  }

  rejectionModal.classList.add('hidden');
  await sendFeedback(currentCurationMatchId, 'REJECTED', reason);
  currentCurationMatchId = null;
});

// ==========================================
// NOTIFICACIONES WEB PUSH
// ==========================================

const btnPushSubscribe = document.getElementById('btn-push-subscribe');
const btnPushSubscribeLabel = document.getElementById('btn-push-subscribe-label');
let swRegistration = null;

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Las notificaciones Web Push no son soportadas en este navegador o entorno.');
    return;
  }

  try {
    // Registrar el Service Worker
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registrado correctamente.');

    if (isUserAuthenticated && currentTenantInfo) {
      btnPushSubscribe.classList.remove('hidden');
      updatePushButton();
    }
  } catch (error) {
    console.error('Error al registrar el Service Worker:', error);
  }
}

// Convertir clave VAPID base64url a Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function updatePushButton() {
  if (!swRegistration || !btnPushSubscribe) return;

  if (Notification.permission === 'denied') {
    btnPushSubscribeLabel.innerText = 'Bloqueado';
    btnPushSubscribe.disabled = true;
    return;
  }

  try {
    const subscription = await swRegistration.pushManager.getSubscription();
    if (subscription) {
      btnPushSubscribeLabel.innerText = 'Notificaciones activas';
      btnPushSubscribe.disabled = true;
      btnPushSubscribe.style.opacity = '0.7';
    } else {
      btnPushSubscribeLabel.innerText = 'Activar notificaciones';
      btnPushSubscribe.disabled = false;
      btnPushSubscribe.style.opacity = '1';
    }
  } catch (err) {
    console.error('Error al obtener suscripción de push:', err);
  }
}

if (btnPushSubscribe) {
  btnPushSubscribe.addEventListener('click', async () => {
    btnPushSubscribe.disabled = true;
    btnPushSubscribeLabel.innerText = 'Solicitando permiso...';

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert('Se requieren permisos de notificación para recibir alertas en tiempo real.');
        updatePushButton();
        return;
      }

      // Obtener la clave pública VAPID del servidor
      const keyRes = await fetch('/api/notifications/vapid-public-key');
      if (!keyRes.ok) throw new Error('No se pudo obtener la clave VAPID pública.');
      const { publicKey } = await keyRes.json();

      const applicationServerKey = urlBase64ToUint8Array(publicKey);
      const subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });

      // Enviar suscripción al backend
      const subRes = await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription })
      });

      if (subRes.ok) {
        console.log('Suscripción Web Push registrada con éxito.');
      } else {
        console.error('Error al guardar la suscripción en el backend.');
      }
    } catch (error) {
      console.error('Error al suscribirse a Web Push:', error);
      alert('Ocurrió un error al activar las notificaciones.');
    } finally {
      updatePushButton();
    }
  });
}

// Inicialización: detectar magic link callback en URL o verificar sesión normal
handleMagicLinkCallback().then(() => {
  checkAuthSession().then(() => {
    handleAuthErrorCallback();
    initPushNotifications();
  });
});

// Handler de Cierre de Sesión
logoutBtn.addEventListener('click', async () => {
  if (!confirm('¿Estás seguro de que deseas cerrar sesión?')) {
    return;
  }

  logoutBtn.disabled = true;
  logoutBtnLabel.innerText = 'Cerrando sesión...';

  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (res.ok) {
      isUserAuthenticated = false;
      currentTenantInfo = null;
      if (btnPushSubscribe) btnPushSubscribe.classList.add('hidden');
      updateTenantSessionUI();
      authOverlay.classList.remove('hidden');
      resetAuthCards();
      stopDashboardPolling();
    } else {
      alert('Error al cerrar sesión.');
    }
  } catch (error) {
    console.error('Error al enviar petición de logout:', error);
    alert('Error de red al intentar cerrar sesión.');
  } finally {
    logoutBtn.disabled = false;
    logoutBtnLabel.innerText = 'Cerrar sesión';
  }
});
