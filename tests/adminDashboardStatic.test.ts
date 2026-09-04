import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { config } from '../src/config/env';
import { mountAdminRouter } from '../src/adminRoutes';

// `fetch` (undici) no deja pisar el header `Host` — hace falta `http.request` crudo para simular
// una request que le llega al host del panel admin (`adminHost`, distinto del host de conexión TCP
// real que sigue siendo 127.0.0.1:<puerto efímero>).
function requestWithHost(
  port: number,
  urlPath: string,
  hostHeader: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, headers: { Host: hostHeader } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// KAN-289: los assets estáticos del panel admin ahora se sirven con `maxAge: '1y'` + `immutable:
// true` (src/adminRoutes.ts), y cada referencia a esos assets en index.html lleva un query string
// `?v=<hash>` atado al contenido del archivo (`assetVersion`) para que un deploy con contenido
// nuevo produzca una URL nueva en vez de depender de que el browser revalide la vieja.
test('KAN-289 - assets estáticos del panel admin: Cache-Control immutable de 1 año', async () => {
  const app = express();
  const originalAdminHost = config.adminHost;
  config.adminHost = 'admin.test.local';
  mountAdminRouter(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No se pudo determinar el puerto.');

  try {
    const res = await requestWithHost(address.port, '/style.css', 'admin.test.local');
    assert.strictEqual(res.status, 200);
    const cacheControl = (res.headers['cache-control'] as string) || '';
    assert.ok(cacheControl.includes('immutable'), `Cache-Control no incluye immutable: ${cacheControl}`);
    assert.ok(cacheControl.includes('max-age=31536000'), `Cache-Control no incluye max-age de 1 año: ${cacheControl}`);
  } finally {
    config.adminHost = originalAdminHost;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('KAN-289 - index.html del panel admin versiona sus assets estáticos con ?v=<hash>', async () => {
  const app = express();
  const originalAdminHost = config.adminHost;
  config.adminHost = 'admin.test.local';
  mountAdminRouter(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No se pudo determinar el puerto.');

  try {
    const res = await requestWithHost(address.port, '/', 'admin.test.local');
    assert.strictEqual(res.status, 200);
    const html = res.body;
    assert.match(html, /\/style\.css\?v=[0-9a-f]{8}"/);
    assert.match(html, /\/app\.js\?v=[0-9a-f]{8}"/);
    assert.match(html, /\/htmlSanitize\.js\?v=[0-9a-f]{8}"/);
    assert.match(html, /\/vendor\/leaflet\/leaflet\.css\?v=[0-9a-f]{8}"/);
    assert.match(html, /\/vendor\/leaflet\/leaflet\.js\?v=[0-9a-f]{8}"/);
  } finally {
    config.adminHost = originalAdminHost;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
