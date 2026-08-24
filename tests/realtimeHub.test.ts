import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import {
  registerSocket,
  unregisterSocket,
  broadcastMatchCountChanged,
  broadcastUploadStatus,
  connectedTenantCount,
  initRealtimeHub,
  runHeartbeatSweep
} from '../src/services/realtimeHub';

function makeFakeSocket() {
  const sent: string[] = [];
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    readyState: 1,
    OPEN: 1,
    sent,
    send: (payload: string) => { sent.push(payload); },
    close: (code?: number, reason?: string) => { emitter.emit('close', code, reason); }
  }) as any;
}

// KAN-128: mismo fake que makeFakeSocket, con ping()/terminate() instrumentados para poder
// aserter el barrido de heartbeat sin depender de sockets TCP reales.
function makeFakeHeartbeatSocket(isAlive: boolean) {
  const socket = makeFakeSocket();
  socket.isAlive = isAlive;
  socket.pingCalls = 0;
  socket.terminateCalls = 0;
  socket.ping = () => { socket.pingCalls++; };
  socket.terminate = () => { socket.terminateCalls++; socket.emit('close'); };
  return socket;
}

// initRealtimeHub monta un WebSocketServer real (necesita un http.Server válido), pero los tests
// de autenticación de acá no abren conexiones de red de verdad — evita depender de que el sandbox
// permita sockets TCP en localhost (poco fiable en algunos entornos de CI/sandbox) disparando el
// evento 'connection' directamente sobre la instancia devuelta, con un socket y un IncomingMessage
// falsos. `initRealtimeHub` nunca usa el server más que para pasárselo al WebSocketServer.
function fakeHttpServer() {
  return new EventEmitter() as any;
}

function fakeIncomingMessage(cookieHeader?: string) {
  return { headers: { cookie: cookieHeader } } as any;
}

test('broadcastMatchCountChanged (KAN-88) - manda el evento solo a los sockets del tenant indicado', () => {
  const socketA = makeFakeSocket();
  const socketB = makeFakeSocket();
  registerSocket('tenant-a', socketA);
  registerSocket('tenant-b', socketB);

  try {
    broadcastMatchCountChanged(['tenant-a']);

    assert.strictEqual(socketA.sent.length, 1);
    assert.deepStrictEqual(JSON.parse(socketA.sent[0]), { type: 'match_count_changed' });
    assert.strictEqual(socketB.sent.length, 0, 'No debe notificar a un tenant que no está en la lista.');
  } finally {
    unregisterSocket('tenant-a', socketA);
    unregisterSocket('tenant-b', socketB);
  }
});

test('broadcastMatchCountChanged (KAN-88) - dedupea tenants repetidos, manda un solo evento por socket', () => {
  const socket = makeFakeSocket();
  registerSocket('tenant-c', socket);

  try {
    broadcastMatchCountChanged(['tenant-c', 'tenant-c', 'tenant-c']);
    assert.strictEqual(socket.sent.length, 1, 'Un tenant repetido en la lista no debe generar eventos duplicados.');
  } finally {
    unregisterSocket('tenant-c', socket);
  }
});

test('broadcastMatchCountChanged (KAN-88) - ignora sockets que no están OPEN', () => {
  const closedSocket = makeFakeSocket();
  closedSocket.readyState = 3; // CLOSED
  registerSocket('tenant-d', closedSocket);

  try {
    assert.doesNotThrow(() => broadcastMatchCountChanged(['tenant-d']));
    assert.strictEqual(closedSocket.sent.length, 0);
  } finally {
    unregisterSocket('tenant-d', closedSocket);
  }
});

test('broadcastMatchCountChanged (KAN-88) - un tenant sin sockets registrados no rompe el broadcast', () => {
  assert.doesNotThrow(() => broadcastMatchCountChanged(['tenant-sin-sockets']));
});

test('broadcastUploadStatus (KAN-137) - manda la etapa solo a los sockets del tenant indicado', () => {
  const socketA = makeFakeSocket();
  const socketB = makeFakeSocket();
  registerSocket('tenant-upload-a', socketA);
  registerSocket('tenant-upload-b', socketB);

  try {
    broadcastUploadStatus('tenant-upload-a', 'parsing_headers');

    assert.strictEqual(socketA.sent.length, 1);
    assert.deepStrictEqual(JSON.parse(socketA.sent[0]), { type: 'upload_status', stage: 'parsing_headers' });
    assert.strictEqual(socketB.sent.length, 0, 'No debe notificar a un tenant que no subió el archivo.');
  } finally {
    unregisterSocket('tenant-upload-a', socketA);
    unregisterSocket('tenant-upload-b', socketB);
  }
});

test('broadcastUploadStatus (KAN-137) - incluye los campos extra pasados junto a la etapa', () => {
  const socket = makeFakeSocket();
  registerSocket('tenant-upload-c', socket);

  try {
    broadcastUploadStatus('tenant-upload-c', 'error', { message: 'Archivo corrupto' });
    assert.deepStrictEqual(JSON.parse(socket.sent[0]), { type: 'upload_status', stage: 'error', message: 'Archivo corrupto' });
  } finally {
    unregisterSocket('tenant-upload-c', socket);
  }
});

test('broadcastUploadStatus (KAN-137) - un tenant sin sockets registrados no rompe el broadcast', () => {
  assert.doesNotThrow(() => broadcastUploadStatus('tenant-sin-sockets', 'done'));
});

test('broadcastUploadStatus (KAN-137) - un tenantId vacío no rompe el broadcast', () => {
  assert.doesNotThrow(() => broadcastUploadStatus('', 'done'));
});

test('unregisterSocket (KAN-88) - saca el tenant del registro cuando se cierra su último socket', () => {
  const socket = makeFakeSocket();
  const before = connectedTenantCount();
  registerSocket('tenant-e', socket);
  assert.strictEqual(connectedTenantCount(), before + 1);

  unregisterSocket('tenant-e', socket);
  assert.strictEqual(connectedTenantCount(), before);
});

test('initRealtimeHub (KAN-88) - autentica con la cookie de sesión y registra el tenant en el hub', async () => {
  const wss = initRealtimeHub(fakeHttpServer(), async (token: string) => {
    if (token === 'token-valido') return { data: { user: { id: 'tenant-real' } }, error: null };
    return { data: { user: null }, error: { message: 'inválido' } };
  });

  const socket = makeFakeSocket();
  const before = connectedTenantCount();

  wss.emit('connection', socket, fakeIncomingMessage('otra_cookie=x; brokaza_session=token-valido'));
  // La autenticación es async (getUser) — deja correr el microtask queue antes de assertar.
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(connectedTenantCount(), before + 1);
  assert.strictEqual(socket.closeCalledWith, undefined, 'Una sesión válida no debe cerrar el socket.');

  socket.emit('close');
  assert.strictEqual(connectedTenantCount(), before, 'Al cerrarse el socket, el tenant debe salir del registro.');
});

test('initRealtimeHub (KAN-88) - rechaza la conexión sin cookie de sesión (close 4401)', async () => {
  const wss = initRealtimeHub(fakeHttpServer(), async () => ({ data: { user: null }, error: { message: 'no debería llamarse' } }));
  const socket = makeFakeSocket();
  let closeArgs: any[] | null = null;
  socket.close = (...args: any[]) => { closeArgs = args; };

  wss.emit('connection', socket, fakeIncomingMessage(undefined));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(closeArgs, [4401, 'No autenticado.']);
});

test('initRealtimeHub (KAN-88) - rechaza la conexión con una sesión inválida/expirada (close 4401)', async () => {
  const wss = initRealtimeHub(fakeHttpServer(), async () => ({ data: { user: null }, error: { message: 'expirada' } }));
  const socket = makeFakeSocket();
  let closeArgs: any[] | null = null;
  socket.close = (...args: any[]) => { closeArgs = args; };

  const before = connectedTenantCount();
  wss.emit('connection', socket, fakeIncomingMessage('brokaza_session=token-invalido'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(closeArgs, [4401, 'Sesión inválida o expirada.']);
  assert.strictEqual(connectedTenantCount(), before, 'No debe registrarse un tenant para una sesión rechazada.');
});

test('initRealtimeHub (KAN-128) - marca isAlive=true al conectar y lo revalida al recibir un pong', async () => {
  const wss = initRealtimeHub(fakeHttpServer(), async () => ({ data: { user: { id: 'tenant-heartbeat' } }, error: null }));
  const socket = makeFakeSocket();

  wss.emit('connection', socket, fakeIncomingMessage('brokaza_session=token-valido'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(socket.isAlive, true, 'Un socket recién conectado debe arrancar vivo.');

  socket.isAlive = false; // simula que un barrido de heartbeat ya lo marcó como pendiente de respuesta
  socket.emit('pong');
  assert.strictEqual(socket.isAlive, true, 'Un pong entrante debe revalidar el socket como vivo.');

  socket.emit('close');
});

test('runHeartbeatSweep (KAN-128) - termina los sockets que no contestaron el ping anterior', () => {
  const deadSocket = makeFakeHeartbeatSocket(false);
  const aliveSocket = makeFakeHeartbeatSocket(true);

  runHeartbeatSweep([deadSocket, aliveSocket]);

  assert.strictEqual(deadSocket.terminateCalls, 1, 'Un socket con isAlive=false debe terminarse.');
  assert.strictEqual(deadSocket.pingCalls, 0, 'No tiene sentido pinguear un socket que ya se está terminando.');
});

test('runHeartbeatSweep (KAN-128) - pinguea y marca isAlive=false a los sockets que siguen vivos', () => {
  const aliveSocket = makeFakeHeartbeatSocket(true);

  runHeartbeatSweep([aliveSocket]);

  assert.strictEqual(aliveSocket.pingCalls, 1, 'Un socket vivo debe recibir un ping en cada barrido.');
  assert.strictEqual(aliveSocket.terminateCalls, 0);
  assert.strictEqual(aliveSocket.isAlive, false, 'Se marca como no confirmado hasta el próximo pong.');
});

test('runHeartbeatSweep (KAN-128) - no rompe con una lista vacía', () => {
  assert.doesNotThrow(() => runHeartbeatSweep([]));
});
