// Variables de Estado en el Cliente
let isConnected = false;
let allGroups = [];
let selectedGroups = [];

// Elementos del DOM
const systemBadge = document.getElementById('system-badge');
const statusText = document.getElementById('status-text');
const qrContainer = document.getElementById('qr-container');
const userInfo = document.getElementById('user-info');
const userName = document.getElementById('user-name');
const userPhone = document.getElementById('user-phone');
const logoutBtn = document.getElementById('logout-btn');

// Elementos del DOM - Pantalla de Carga
const loadingOverlay = document.getElementById('loading-overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayDesc = document.getElementById('overlay-desc');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');
const propertiesCount = document.getElementById('properties-count');

// Elementos del DOM - Grupos
const toggleEditGroupsBtn = document.getElementById('toggle-edit-groups-btn');
const cancelEditGroupsBtn = document.getElementById('cancel-edit-groups-btn');
const groupsViewSection = document.getElementById('groups-view-section');
const groupsEditSection = document.getElementById('groups-edit-section');
const noGroupsSelectedMsg = document.getElementById('no-groups-selected-msg');
const groupSearch = document.getElementById('group-search');
const groupsList = document.getElementById('groups-list');
const saveGroupsBtn = document.getElementById('save-groups-btn');
const saveStatus = document.getElementById('save-status');

const matchesTbody = document.getElementById('matches-tbody');

// Elementos del DOM - Auth Magic Link
const authOverlay = document.getElementById('auth-overlay');
const authCardStep1 = document.getElementById('auth-card-step1');
const authCardStep2 = document.getElementById('auth-card-step2');
const authEmailInput = document.getElementById('auth-email-input');
const authSendMagicLinkBtn = document.getElementById('auth-send-magic-link-btn');
const authBackBtn = document.getElementById('auth-back-btn');
const authStep1Error = document.getElementById('auth-step1-error');
const authStep2Error = document.getElementById('auth-step2-error');

// Estado de Autenticación
let authCheckInterval = null;
let statusInterval = null;
let matchesInterval = null;
let catalogInterval = null;
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

async function checkAuthSession() {
  try {
    const res = await fetch('/api/auth/session');
    const data = await res.json();

    if (data.authenticated) {
      currentTenantInfo = data.tenant;
      isUserAuthenticated = true;
      authOverlay.classList.add('hidden');
      isConnected = false;
      startDashboardPolling();
    } else {
      isUserAuthenticated = false;
      currentTenantInfo = null;
      authOverlay.classList.remove('hidden');
      resetAuthCards();
      stopDashboardPolling();
    }
  } catch (error) {
    console.error('Error al comprobar sesión auth:', error);
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

  try {
    const res = await fetch('/api/auth/exchange-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token })
    });
    if (!res.ok) {
      const data = await res.json();
      console.error('[AUTH] Error al intercambiar token:', data.error);
    }
  } catch (error) {
    console.error('[AUTH] Error de red al intercambiar token:', error);
  }
  return true;
}

function startDashboardPolling() {
  if (statusInterval) return; // Ya está corriendo

  checkStatus();
  loadCatalogInfo();
  loadMatches();

  statusInterval = setInterval(checkStatus, 1500);
  matchesInterval = setInterval(loadMatches, 2000);
  catalogInterval = setInterval(loadCatalogInfo, 5000);
}

function stopDashboardPolling() {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  if (matchesInterval) {
    clearInterval(matchesInterval);
    matchesInterval = null;
  }
  if (catalogInterval) {
    clearInterval(catalogInterval);
    catalogInterval = null;
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

  try {
    const res = await fetch('/api/auth/request-magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const data = await res.json();
    if (res.ok) {
      authCardStep1.classList.add('hidden');
      authCardStep2.classList.remove('hidden');
    } else {
      showAuthError(authStep1Error, data.error || 'Error al enviar el magic link.');
    }
  } catch (error) {
    showAuthError(authStep1Error, 'Error de red al conectar con el servidor.');
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
// POLLING DE WHATSAPP (LOGUEADO)
// ==========================================

async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    updateStatusUI(data);
  } catch (error) {
    console.error('Error al consultar estado:', error);
    systemBadge.className = 'system-badge disconnected';
    statusText.innerText = 'Desconectado (Error de Red)';
    updateStatusUI({ status: 'DISCONNECTED' });
  }
}

function updateStatusUI(data) {
  if (data.status !== 'AUTHENTICATED') {
    loadingOverlay.classList.add('hidden');
  }

  if (data.status === 'CONNECTED') {
    systemBadge.className = 'system-badge connected';
    statusText.innerText = 'Conectado';
    toggleEditGroupsBtn.disabled = false;

    // Ocultar el overlay de vinculación/inicio si se conectó con éxito
    if (!authOverlay.classList.contains('hidden')) {
      authOverlay.classList.add('hidden');
    }
    if (currentTenantInfo) {
      isUserAuthenticated = true;
      const btnPushSubscribe = document.getElementById('btn-push-subscribe');
      if (btnPushSubscribe && typeof swRegistration !== 'undefined' && swRegistration) {
        btnPushSubscribe.classList.remove('hidden');
        updatePushButton();
      }
    }

    if (!isConnected) {
      isConnected = true;
      userInfo.classList.remove('hidden');
      userName.innerText = data.user.name;
      userPhone.innerText = `+${data.user.number}`;

      qrContainer.innerHTML = '<div class="qr-success-icon">✅</div><p class="qr-placeholder-text" style="color: var(--success); font-weight: 600;">¡WhatsApp Conectado y Activo!</p>';
      qrContainer.style.background = 'rgba(16, 185, 129, 0.03)';
      qrContainer.style.borderColor = 'rgba(16, 185, 129, 0.2)';

      loadGroups();
    }
  } else if (data.status === 'AUTHENTICATED') {
    isConnected = false;
    userInfo.classList.add('hidden');
    toggleEditGroupsBtn.disabled = true;

    systemBadge.className = 'system-badge connected';
    statusText.innerText = 'Autenticado';
    const authedHtml = '<div class="spinner"></div><p class="qr-placeholder-text" style="color: var(--warning); font-weight: 600;">¡Autenticado! Sincronizando chats de WhatsApp...</p>';
    qrContainer.innerHTML = authedHtml;
    qrContainer.style.background = 'rgba(255, 255, 255, 0.03)';
    qrContainer.style.borderColor = 'var(--card-border)';

    const summaryBox = document.getElementById('selected-groups-summary');
    if (summaryBox) summaryBox.classList.add('hidden');
    noGroupsSelectedMsg.classList.remove('hidden');
    noGroupsSelectedMsg.innerHTML = '<div class="spinner" style="width: 25px; height: 25px; margin: 0 auto 0.5rem;"></div>Sincronizando grupos desde WhatsApp...';

    loadingOverlay.classList.remove('hidden');
    const percent = data.syncPercentage || 0;
    progressBar.style.width = percent + '%';
    progressText.innerText = percent + '%';
    overlayDesc.innerText = data.syncMessage || 'Iniciando sincronización de chats...';
  } else {
    isConnected = false;
    userInfo.classList.add('hidden');
    toggleEditGroupsBtn.disabled = true;
    const btnPushSubscribe = document.getElementById('btn-push-subscribe');
    if (btnPushSubscribe) btnPushSubscribe.classList.add('hidden');

    groupsEditSection.classList.add('hidden');
    groupsViewSection.classList.remove('hidden');

    const summaryBox = document.getElementById('selected-groups-summary');
    if (summaryBox) summaryBox.classList.add('hidden');

    noGroupsSelectedMsg.classList.remove('hidden');

    if (data.status === 'QR_RECEIVED' && data.qrDataUrl) {
      systemBadge.className = 'system-badge';
      statusText.innerText = 'Esperando Escaneo';

      const qrImageHtml = `<img src="${data.qrDataUrl}" alt="Escanea el QR" class="qr-image" style="max-width: 100%; height: auto; display: block; margin: 0 auto;">`;
      qrContainer.innerHTML = qrImageHtml;
      qrContainer.style.background = 'white';
      qrContainer.style.borderColor = 'var(--card-border)';

      noGroupsSelectedMsg.innerText = 'Conecta WhatsApp para ver tus grupos...';
    } else if (data.status === 'INITIALIZING') {
      systemBadge.className = 'system-badge';
      statusText.innerText = 'Inicializando...';
      const initHtml = '<div class="spinner"></div><p class="qr-placeholder-text">Cargando WhatsApp Web...</p>';
      qrContainer.innerHTML = initHtml;
      noGroupsSelectedMsg.innerHTML = '<div class="spinner" style="width: 25px; height: 25px; margin: 0 auto 0.5rem;"></div>Iniciando WhatsApp...';
    } else if (data.status === 'DISCONNECTED') {
      systemBadge.className = 'system-badge disconnected';
      statusText.innerText = 'Desconectado';
      const discHtml = '<div class="spinner"></div><p class="qr-placeholder-text">Generando conexion...</p>';
      qrContainer.innerHTML = discHtml;
      noGroupsSelectedMsg.innerText = 'WhatsApp desconectado. Esperando conexión...';
    }
  }
}

// ==========================================
// LOGS Y CATÁLOGO DEL DASHBOARD
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

async function loadGroups() {
  try {
    const res = await fetch('/api/groups');
    const data = await res.json();

    allGroups = data.groups || [];
    selectedGroups = data.selected || [];

    renderGroups();
    updateSelectedGroupsSummary();
  } catch (error) {
    console.error('Error al cargar grupos:', error);
    groupsList.innerHTML = '<p class="list-placeholder error">Error al obtener grupos de WhatsApp</p>';
  }
}

function updateSelectedGroupsSummary() {
  const summaryBox = document.getElementById('selected-groups-summary');
  const tagsContainer = document.getElementById('selected-groups-tags');
  if (!summaryBox || !tagsContainer) return;

  if (selectedGroups.length === 0) {
    summaryBox.classList.add('hidden');
    noGroupsSelectedMsg.classList.remove('hidden');
    noGroupsSelectedMsg.innerText = 'No has seleccionado ningún grupo aún. Haz clic en "Editar Grupos" para empezar.';
    return;
  }

  noGroupsSelectedMsg.classList.add('hidden');
  summaryBox.classList.remove('hidden');
  tagsContainer.innerHTML = '';

  selectedGroups.forEach(id => {
    const group = allGroups.find(g => g.id === id);
    const name = group ? group.name : id;

    const span = document.createElement('span');
    span.className = 'group-tag';
    span.innerText = name;
    tagsContainer.appendChild(span);
  });
}

toggleEditGroupsBtn.addEventListener('click', async () => {
  groupsViewSection.classList.add('hidden');
  groupsEditSection.classList.remove('hidden');
  groupsList.innerHTML = '<div class="spinner" style="width: 25px; height: 25px; margin: 2rem auto 0.5rem;"></div>Sincronizando grupos desde WhatsApp...';

  await loadGroups();
  populateManualGroupsInput();
});

function populateManualGroupsInput() {
  const manualInput = document.getElementById('manual-groups-input');
  if (!manualInput) return;

  const manualNames = [];
  selectedGroups.forEach(idOrName => {
    const groupExists = allGroups.some(g => g.id === idOrName || g.name === idOrName);
    if (!groupExists) {
      manualNames.push(idOrName);
    }
  });
  manualInput.value = manualNames.join('\n');
}

cancelEditGroupsBtn.addEventListener('click', () => {
  groupsEditSection.classList.add('hidden');
  groupsViewSection.classList.remove('hidden');
  loadGroups();
});

function renderGroups() {
  const query = groupSearch.value.toLowerCase();
  const filtered = allGroups.filter(g => g.name.toLowerCase().includes(query));

  if (filtered.length === 0) {
    groupsList.innerHTML = '<p class="list-placeholder">No se encontraron grupos</p>';
    return;
  }

  groupsList.innerHTML = '';
  filtered.forEach(group => {
    const isChecked = selectedGroups.includes(group.id) || selectedGroups.includes(group.name);

    const div = document.createElement('div');
    div.className = 'group-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `group-${group.id}`;
    checkbox.value = group.id;
    checkbox.checked = isChecked;

    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        if (!selectedGroups.includes(group.id)) selectedGroups.push(group.id);
      } else {
        selectedGroups = selectedGroups.filter(id => id !== group.id && id !== group.name);
      }
    });

    const label = document.createElement('label');
    label.htmlFor = `group-${group.id}`;
    label.className = 'group-name';
    label.innerText = group.name;

    div.appendChild(checkbox);
    div.appendChild(label);
    groupsList.appendChild(div);
  });
}

saveGroupsBtn.addEventListener('click', async () => {
  saveGroupsBtn.disabled = true;
  saveStatus.innerText = 'Guardando...';
  saveStatus.style.color = 'var(--text-secondary)';

  const manualInput = document.getElementById('manual-groups-input');
  const manualNames = manualInput
    ? manualInput.value.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    : [];

  const finalSelectedGroups = Array.from(new Set([...selectedGroups, ...manualNames]));

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedGroups: finalSelectedGroups })
    });

    if (res.ok) {
      saveStatus.innerText = '¡Guardado!';
      saveStatus.style.color = 'var(--success)';
      selectedGroups = finalSelectedGroups;
      updateSelectedGroupsSummary();

      setTimeout(() => {
        groupsEditSection.classList.add('hidden');
        groupsViewSection.classList.remove('hidden');
      }, 1000);
    } else {
      saveStatus.innerText = 'Error al guardar.';
      saveStatus.style.color = 'var(--error)';
    }
  } catch (error) {
    console.error(error);
    saveStatus.innerText = 'Error de red.';
    saveStatus.style.color = 'var(--error)';
  } finally {
    setTimeout(() => {
      saveStatus.innerText = '';
      saveGroupsBtn.disabled = false;
    }, 1500);
  }
});

groupSearch.addEventListener('input', renderGroups);
dropzone.addEventListener('click', () => fileInput.click());

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
      matchesTbody.innerHTML = '<tr><td colspan="6" class="table-placeholder">No se han registrado matches en esta sesión.</td></tr>';
      document.getElementById('page-start').innerText = '0';
      document.getElementById('page-end').innerText = '0';
      document.getElementById('total-matches').innerText = '0';
      document.getElementById('current-page-text').innerText = 'Pág. 1 de 1';
      document.getElementById('prev-page-btn').disabled = true;
      document.getElementById('next-page-btn').disabled = true;
      return;
    }

    let matchesList = [...matches];

    if (sortOption === 'fecha-desc') {
      // Orden nativo
    } else if (sortOption === 'fecha-asc') {
      matchesList.reverse();
    } else if (sortOption === 'score-desc') {
      matchesList.sort((a, b) => getScore(b) - getScore(a));
    } else if (sortOption === 'score-asc') {
      matchesList.sort((a, b) => getScore(a) - getScore(b));
    }

    const totalMatches = matchesList.length;
    const totalPages = Math.ceil(totalMatches / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalMatches);
    const paginatedMatches = matchesList.slice(startIndex, endIndex);

    document.getElementById('page-start').innerText = totalMatches > 0 ? startIndex + 1 : 0;
    document.getElementById('page-end').innerText = endIndex;
    document.getElementById('total-matches').innerText = totalMatches;
    document.getElementById('current-page-text').innerText = `Pág. ${currentPage} de ${totalPages}`;
    document.getElementById('prev-page-btn').disabled = currentPage <= 1;
    document.getElementById('next-page-btn').disabled = currentPage >= totalPages;

    matchesTbody.innerHTML = '';
    paginatedMatches.forEach(m => {
      const tr = document.createElement('tr');

      const tdFecha = document.createElement('td');
      tdFecha.innerText = m.fecha;

      const tdProp = document.createElement('td');
      tdProp.innerHTML = `<strong>${m.property.domicilio}</strong><br><small>${m.property.moneda} ${m.property.precio} (${m.property.operacion})</small>`;

      const tdPedido = document.createElement('td');
      tdPedido.innerText = m.originalText;

      const tdSolicitante = document.createElement('td');
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
      tdSolicitante.innerHTML = `${contactHtml}<br><span class="match-group-tag">${m.groupName || 'Grupo Desconocido'}</span>`;

      const tdDetalles = document.createElement('td');
      const divDetails = document.createElement('div');
      divDetails.className = 'match-reasons';
      divDetails.innerText = m.matchDetails;
      tdDetalles.appendChild(divDetails);

      const tdCuracion = document.createElement('td');
      if (m.userReviewStatus === 'ACCEPTED') {
        tr.className = 'match-accepted';
        tdCuracion.innerHTML = `<span class="curation-badge accepted">✅ Aceptado</span>`;
      } else if (m.userReviewStatus === 'REJECTED') {
        tr.className = 'match-rejected';
        tdCuracion.innerHTML = `<span class="curation-badge rejected">❌ Rechazado</span><span class="curation-reason-text" title="${m.feedbackReason || ''}">${m.feedbackReason || 'No especificado'}</span>`;
      } else {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'curation-actions-container';

        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'btn btn-success btn-small';
        acceptBtn.innerText = 'Aceptar';
        acceptBtn.addEventListener('click', () => sendFeedback(m.id, 'ACCEPTED'));

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'btn btn-danger btn-small';
        rejectBtn.innerText = 'Rechazar';
        rejectBtn.addEventListener('click', () => openRejectionModal(m.id));

        actionsDiv.appendChild(acceptBtn);
        actionsDiv.appendChild(rejectBtn);
        tdCuracion.appendChild(actionsDiv);
      }

      tr.appendChild(tdFecha);
      tr.appendChild(tdProp);
      tr.appendChild(tdPedido);
      tr.appendChild(tdSolicitante);
      tr.appendChild(tdDetalles);
      tr.appendChild(tdCuracion);

      matchesTbody.appendChild(tr);
    });
  } catch (error) {
    console.error('Error al cargar historial de matches:', error);
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
    btnPushSubscribe.innerText = '🔔 Bloqueado';
    btnPushSubscribe.disabled = true;
    return;
  }

  try {
    const subscription = await swRegistration.pushManager.getSubscription();
    if (subscription) {
      btnPushSubscribe.innerText = '✅ Notificaciones Activas';
      btnPushSubscribe.disabled = true;
      btnPushSubscribe.style.opacity = '0.7';
    } else {
      btnPushSubscribe.innerText = '🔔 Activar Notificaciones';
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
    btnPushSubscribe.innerText = 'Solicitando permiso...';

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
    initPushNotifications();
  });
});

// Handler de Cierre de Sesión
logoutBtn.addEventListener('click', async () => {
  if (!confirm('¿Estás seguro de que deseas cerrar sesión y desconectar el bot de WhatsApp?')) {
    return;
  }

  logoutBtn.disabled = true;
  logoutBtn.innerText = 'Cerrando sesión...';

  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    if (res.ok) {
      isUserAuthenticated = false;
      currentTenantInfo = null;
      if (btnPushSubscribe) btnPushSubscribe.classList.add('hidden');
      userInfo.classList.add('hidden');
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
    logoutBtn.innerText = '🚪 Cerrar Sesión';
  }
});
