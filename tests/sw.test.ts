import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// KAN-46: sw.js es un service worker clásico (registrado sin { type: 'module' } en app.js),
// así que no puede usar import/export sin romper en el browser. Para poder testearlo con
// node:test sin duplicar su lógica, ejecutamos el archivo real tal cual se sirve (fs.readFileSync)
// dentro de un contexto vm con self/clients fake — así el test cubre el artefacto real, no una copia.

interface ShowNotificationCall {
  title: string;
  options: any;
}

function loadServiceWorker() {
  const swSource = fs.readFileSync(path.join(__dirname, '../src/dashboard/sw.js'), 'utf8');

  const listeners: Record<string, Function[]> = {};
  const showNotificationCalls: ShowNotificationCall[] = [];
  let openedUrl: string | null = null;

  const fakeSelf: any = {
    addEventListener(type: string, handler: Function) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    registration: {
      showNotification(title: string, options: any) {
        showNotificationCalls.push({ title, options });
      }
    }
  };

  let matchAllResult: any[] = [];
  const fakeClients = {
    matchAll: async () => matchAllResult,
    openWindow: (url: string) => { openedUrl = url; }
  };

  // Corre en el mismo realm que el test (en vez de vm.createContext, que crea un realm nuevo con
  // su propio Object/Array.prototype y rompe assert.deepStrictEqual sobre objetos/arrays creados
  // por el sw.js real). self/clients quedan como globals: los listeners registrados por sw.js los
  // resuelven recién cuando se disparan (no al cargar el script), así que no se pueden borrar acá.
  (global as any).self = fakeSelf;
  (global as any).clients = fakeClients;
  const script = new vm.Script(swSource, { filename: 'sw.js' });
  script.runInThisContext();

  return {
    dispatchPush: async (data: unknown, malformed = false) => {
      const promises: Promise<any>[] = [];
      const event = {
        data: {
          json: () => {
            if (malformed) throw new SyntaxError('JSON inválido');
            return data;
          },
          text: () => (typeof data === 'string' ? data : JSON.stringify(data))
        },
        waitUntil: (p: Promise<any>) => promises.push(p)
      };
      for (const handler of listeners['push'] || []) handler(event);
      await Promise.all(promises);
    },
    dispatchNotificationClick: async (notificationData: any, clientList: any[] = []) => {
      matchAllResult = clientList;
      const promises: Promise<any>[] = [];
      const event = {
        notification: { close: () => {}, data: notificationData },
        waitUntil: (p: Promise<any>) => promises.push(p)
      };
      for (const handler of listeners['notificationclick'] || []) handler(event);
      await Promise.all(promises);
    },
    showNotificationCalls,
    getOpenedUrl: () => openedUrl
  };
}

test('sw.js push - muestra el texto minimizado exacto de KAN-45 (title/body)', async () => {
  const sw = loadServiceWorker();

  await sw.dispatchPush({
    title: 'Matchouse',
    body: 'Tenés un match nuevo — tocá para ver',
    tag: 'search-match-123',
    data: { url: '/' }
  });

  assert.strictEqual(sw.showNotificationCalls.length, 1);
  assert.strictEqual(sw.showNotificationCalls[0].title, 'Matchouse');
  assert.strictEqual(sw.showNotificationCalls[0].options.body, 'Tenés un match nuevo — tocá para ver');
});

test('sw.js push (KAN-46) - el botón de acción usa el texto "Tocá para ver"', async () => {
  const sw = loadServiceWorker();

  await sw.dispatchPush({
    title: 'Matchouse',
    body: 'Tenés un match nuevo — tocá para ver',
    tag: 'search-match-123',
    data: { url: '/' }
  });

  assert.deepStrictEqual(sw.showNotificationCalls[0].options.actions, [{ action: 'open', title: 'Tocá para ver' }]);
});

test('sw.js push - propaga tag y data.url del payload sin modificarlos', async () => {
  const sw = loadServiceWorker();

  await sw.dispatchPush({ title: 'Matchouse', body: 'Tenés un match nuevo — tocá para ver', tag: 'search-match-456', data: { url: '/' } });

  assert.strictEqual(sw.showNotificationCalls[0].options.tag, 'search-match-456');
  assert.deepStrictEqual(sw.showNotificationCalls[0].options.data, { url: '/' });
});

test('sw.js push (regresión) - usa "Matchouse" y tag por default cuando el payload no los trae', async () => {
  const sw = loadServiceWorker();

  await sw.dispatchPush({ body: 'Tenés un match nuevo — tocá para ver' });

  assert.strictEqual(sw.showNotificationCalls[0].title, 'Matchouse');
  assert.strictEqual(sw.showNotificationCalls[0].options.tag, 'housematch-notification');
  assert.deepStrictEqual(sw.showNotificationCalls[0].options.data, {});
});

test('sw.js push (regresión) - JSON malformado no rompe el handler, cae al texto crudo', async () => {
  const sw = loadServiceWorker();

  await sw.dispatchPush('no-es-json-valido', true);

  assert.strictEqual(sw.showNotificationCalls.length, 1);
  assert.strictEqual(sw.showNotificationCalls[0].title, 'Matchouse');
  assert.strictEqual(sw.showNotificationCalls[0].options.body, 'no-es-json-valido');
});

test('sw.js notificationclick (KAN-46 AC4) - abre el dashboard en data.url cuando no hay ventana ya abierta', async () => {
  const sw = loadServiceWorker();

  await sw.dispatchNotificationClick({ url: '/' }, []);

  assert.strictEqual(sw.getOpenedUrl(), '/');
});

test('sw.js notificationclick (regresión) - default a "/" cuando la notificación no trae data.url', async () => {
  const sw = loadServiceWorker();

  await sw.dispatchNotificationClick({}, []);

  assert.strictEqual(sw.getOpenedUrl(), '/');
});

test('sw.js notificationclick (regresión) - hace foco en una ventana ya abierta en vez de abrir una nueva', async () => {
  const sw = loadServiceWorker();
  let focused = false;
  const fakeClient = { url: 'http://localhost:3000/', focus: () => { focused = true; } };

  await sw.dispatchNotificationClick({ url: '/' }, [fakeClient]);

  assert.strictEqual(focused, true, 'Debería enfocar la ventana existente.');
  assert.strictEqual(sw.getOpenedUrl(), null, 'No debería abrir una ventana nueva si ya hay una abierta.');
});
