import test from 'node:test';
import assert from 'node:assert';
import * as path from 'path';

// htmlSanitize.js es un script de browser plano (sin tipos ni allowJs habilitado en tsconfig),
// se carga con require() en vez de import — mismo criterio que tests/iosOnboarding.test.ts.
const { escapeHtml, zoneBadge } = require(path.join('..', 'src', 'admin-dashboard', 'htmlSanitize'));

test('escapeHtml (KAN-136) escapa los 5 caracteres peligrosos de HTML/atributos', () => {
  assert.strictEqual(escapeHtml('&'), '&amp;');
  assert.strictEqual(escapeHtml('<'), '&lt;');
  assert.strictEqual(escapeHtml('>'), '&gt;');
  assert.strictEqual(escapeHtml('"'), '&quot;');
  assert.strictEqual(escapeHtml("'"), '&#39;');
});

test('escapeHtml (KAN-136) neutraliza un intento de romper un atributo title="..." con comillas dobles', () => {
  const malicious = 'Centro" onmouseover="alert(1)';
  const escaped = escapeHtml(malicious);
  assert.ok(!escaped.includes('"'), 'No debe quedar ninguna comilla doble sin escapar.');
  assert.strictEqual(escaped, 'Centro&quot; onmouseover=&quot;alert(1)');
});

test('escapeHtml (KAN-136) neutraliza un intento de inyección de tag <script>', () => {
  const malicious = '<script>alert(1)</script>';
  const escaped = escapeHtml(malicious);
  assert.ok(!escaped.includes('<script>'));
  assert.strictEqual(escaped, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml (KAN-136) trata null/undefined como string vacío en vez de tirar', () => {
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
});

test('escapeHtml (KAN-136) deja intacto un string sin caracteres especiales', () => {
  assert.strictEqual(escapeHtml('Centro'), 'Centro');
});

test('zoneBadge (KAN-136) escapa zone.name y textSuggestedZone.name dentro del atributo title cuando hay discrepancia', () => {
  const property = {
    hasDiscrepancy: true,
    zone: { name: 'Centro" onmouseover="alert(1)' },
    textSuggestedZone: { name: 'Yerba Buena" onclick="alert(2)' }
  };
  const html = zoneBadge(property);

  // El markup tiene 2 atributos con comillas dobles (class y title) — 4 comillas en total. Lo que
  // importa es que el contenido de `zone`/`textSuggestedZone` no meta comillas dobles CRUDAS que
  // cierren el atributo antes de tiempo (deben quedar como &quot;).
  const titleMatch = html.match(/title="([^"]*)"/);
  assert.ok(titleMatch, 'El atributo title debe parsear como un único atributo bien formado (comillas balanceadas).');
  // "onmouseover=" como texto plano DENTRO del valor de title es inofensivo — lo que hay que
  // verificar es que no aparezca crudo como `" onmouseover="`, que rompería el atributo y lo
  // convertiría en un handler de evento real.
  assert.ok(!html.includes('" onmouseover="'), 'onmouseover no debe romper el atributo title (comilla cruda sin escapar).');
  assert.ok(!html.includes('" onclick="'), 'onclick no debe romper el atributo title (comilla cruda sin escapar).');
  assert.ok(html.includes('title="Punto: Centro&quot; onmouseover=&quot;alert(1) | Texto sugiere: Yerba Buena&quot; onclick=&quot;alert(2)"'));
});

test('zoneBadge (KAN-136) escapa zone.name en el texto visible del badge (zoneSource: point)', () => {
  const html = zoneBadge({ hasDiscrepancy: false, zoneSource: 'point', zone: { name: '<b>Centro</b>' } });
  assert.ok(!html.includes('<b>Centro</b>'));
  assert.ok(html.includes('&lt;b&gt;Centro&lt;/b&gt;'));
});

test('zoneBadge (KAN-136) escapa zone.name en el texto visible del badge (zoneSource: text)', () => {
  const html = zoneBadge({ hasDiscrepancy: false, zoneSource: 'text', zone: { name: '<img src=x onerror=alert(1)>' } });
  assert.ok(!html.includes('<img'));
});

test('zoneBadge (KAN-136) zoneSource "none" no interpola ningún dato dinámico', () => {
  const html = zoneBadge({ hasDiscrepancy: false, zoneSource: 'none' });
  assert.strictEqual(html, '<span class="badge none">Sin zona resuelta</span>');
});
