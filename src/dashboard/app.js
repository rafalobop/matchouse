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

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');
const propertiesCount = document.getElementById('properties-count');

const groupSearch = document.getElementById('group-search');
const groupsList = document.getElementById('groups-list');
const saveGroupsBtn = document.getElementById('save-groups-btn');
const saveStatus = document.getElementById('save-status');

const matchesTbody = document.getElementById('matches-tbody');

// Polling de Estado de WhatsApp
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    updateStatusUI(data);
  } catch (error) {
    console.error('Error al consultar estado:', error);
    systemBadge.className = 'system-badge disconnected';
    statusText.innerText = 'Desconectado (Error de Red)';
  }
}

function updateStatusUI(data) {
  // Configurar insignia de estado
  if (data.status === 'CONNECTED') {
    systemBadge.className = 'system-badge connected';
    statusText.innerText = 'Conectado';
    
    if (!isConnected) {
      isConnected = true;
      // Mostrar info de usuario
      userInfo.classList.remove('hidden');
      userName.innerText = data.user.name;
      userPhone.innerText = `+${data.user.number}`;
      
      // Ocultar QR y mostrar éxito (sin spinner)
      qrContainer.innerHTML = '<div class="qr-success-icon">✅</div><p class="qr-placeholder-text" style="color: var(--success); font-weight: 600;">¡WhatsApp Conectado y Activo!</p>';
      qrContainer.style.background = 'rgba(16, 185, 129, 0.03)';
      qrContainer.style.borderColor = 'rgba(16, 185, 129, 0.2)';

      // Cargar lista de grupos
      loadGroups();
    }
  } else {
    isConnected = false;
    userInfo.classList.add('hidden');
    saveGroupsBtn.disabled = true;

    if (data.status === 'QR_RECEIVED' && data.qrDataUrl) {
      systemBadge.className = 'system-badge';
      statusText.innerText = 'Esperando Escaneo';
      qrContainer.innerHTML = `<img src="${data.qrDataUrl}" alt="Escanea el QR" class="qr-image">`;
      qrContainer.style.background = 'white';
      qrContainer.style.borderColor = 'var(--card-border)';
    } else if (data.status === 'INITIALIZING') {
      systemBadge.className = 'system-badge';
      statusText.innerText = 'Inicializando...';
      qrContainer.innerHTML = '<div class="spinner"></div><p class="qr-placeholder-text">Cargando WhatsApp Web...</p>';
    } else {
      systemBadge.className = 'system-badge disconnected';
      statusText.innerText = 'Desconectado';
      qrContainer.innerHTML = '<div class="spinner"></div><p class="qr-placeholder-text">Desconectado. Reintentando...</p>';
    }
  }
}

// Cargar catálogo info
async function loadCatalogInfo() {
  try {
    const res = await fetch('/api/catalog');
    const data = await res.json();
    propertiesCount.innerText = data.count || '0';
  } catch (error) {
    console.error('Error al cargar info de catálogo:', error);
  }
}

// Cargar Grupos de WhatsApp
async function loadGroups() {
  try {
    const res = await fetch('/api/groups');
    const data = await res.json();
    
    allGroups = data.groups || [];
    selectedGroups = data.selected || [];
    
    renderGroups();
    updateSelectedGroupsSummary();
    saveGroupsBtn.disabled = false;
  } catch (error) {
    console.error('Error al cargar grupos:', error);
    groupsList.innerHTML = '<p class="list-placeholder error">Error al obtener grupos de WhatsApp</p>';
  }
}

// Actualizar resumen visual de grupos escuchados
function updateSelectedGroupsSummary() {
  const summaryBox = document.getElementById('selected-groups-summary');
  const tagsContainer = document.getElementById('selected-groups-tags');
  if (!summaryBox || !tagsContainer) return;

  if (selectedGroups.length === 0) {
    summaryBox.classList.add('hidden');
    return;
  }

  summaryBox.classList.remove('hidden');
  tagsContainer.innerHTML = '';
  
  selectedGroups.forEach(id => {
    // Buscar el nombre del grupo a partir del ID
    const group = allGroups.find(g => g.id === id);
    const name = group ? group.name : id;
    
    const span = document.createElement('span');
    span.className = 'group-tag';
    span.innerText = name;
    tagsContainer.appendChild(span);
  });
}

// Renderizar la lista de grupos con filtro
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
    
    // Cambiar estado en memoria al tildar/destildar
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

// Guardar Configuración de Grupos
saveGroupsBtn.addEventListener('click', async () => {
  saveGroupsBtn.disabled = true;
  saveStatus.innerText = 'Guardando...';
  saveStatus.style.color = 'var(--text-secondary)';

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedGroups })
    });

    if (res.ok) {
      saveStatus.innerText = '¡Guardado con éxito!';
      saveStatus.style.color = 'var(--success)';
      updateSelectedGroupsSummary();
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
      saveGroupsBtn.disabled = !isConnected;
    }, 3000);
  }
});

// Buscar grupos en tiempo real
groupSearch.addEventListener('input', renderGroups);

// Drag & Drop para el Excel
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

// Subida de Archivo Excel
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
      showUploadStatus(`¡Éxito! Se cargaron ${data.count} propiedades en memoria.`, 'success');
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

// Cargar Logs de Matches en tiempo real
async function loadMatches() {
  try {
    const res = await fetch('/api/matches');
    const data = await res.json();
    
    const matches = data.matches || [];
    
    if (matches.length === 0) {
      matchesTbody.innerHTML = '<tr><td colspan="5" class="table-placeholder">No se han registrado matches en esta sesión.</td></tr>';
      return;
    }

    matchesTbody.innerHTML = '';
    matches.forEach(m => {
      const tr = document.createElement('tr');
      
      const tdFecha = document.createElement('td');
      tdFecha.innerText = m.fecha;
      
      const tdProp = document.createElement('td');
      tdProp.innerHTML = `<strong>${m.property.domicilio}</strong><br><small>${m.property.moneda} ${m.property.precio} (${m.property.operacion})</small>`;
      
      const tdPedido = document.createElement('td');
      tdPedido.innerText = m.originalText;
      
      const tdSolicitante = document.createElement('td');
      tdSolicitante.innerHTML = `${m.contactSender}<br><span class="match-group-tag">${m.groupName || 'Grupo Desconocido'}</span>`;
      
      const tdDetalles = document.createElement('td');
      const divDetails = document.createElement('div');
      divDetails.className = 'match-reasons';
      divDetails.innerText = m.matchDetails;
      tdDetalles.appendChild(divDetails);

      tr.appendChild(tdFecha);
      tr.appendChild(tdProp);
      tr.appendChild(tdPedido);
      tr.appendChild(tdSolicitante);
      tr.appendChild(tdDetalles);
      
      matchesTbody.appendChild(tr);
    });
  } catch (error) {
    console.error('Error al cargar historial de matches:', error);
  }
}

// Inicialización de Polling
checkStatus();
loadCatalogInfo();
loadMatches();

setInterval(checkStatus, 2000);   // Consultar QR/Conexión cada 2 segundos
setInterval(loadMatches, 5000);   // Consultar matches cada 5 segundos
