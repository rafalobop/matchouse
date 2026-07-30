import test from 'node:test';
import assert from 'node:assert';
import { computeHeaderSignature, matchHeadersHeuristically } from '../src/utils/excelHeaderMatcher';

test('excelHeaderMatcher - computeHeaderSignature normaliza mayúsculas/espacios y ordena, sin importar el orden original', () => {
  const a = computeHeaderSignature(['Domicilio', ' Precio ', 'Dormitorios']);
  const b = computeHeaderSignature(['dormitorios', 'domicilio', 'precio']);

  assert.strictEqual(a, b, 'Dos listas de headers con el mismo contenido pero distinto orden/casing deben producir la misma firma.');
});

test('excelHeaderMatcher - computeHeaderSignature ignora headers vacíos', () => {
  const signature = computeHeaderSignature(['Domicilio', '', 'Precio', undefined as any]);
  assert.strictEqual(signature, 'domicilio|precio');
});

test('excelHeaderMatcher - resuelve con confianza alta un set de headers estándar en español', () => {
  const result = matchHeadersHeuristically(['Domicilio', 'Piso/Lote', 'Precio', 'Dormitorios', 'Contacto']);

  assert.strictEqual(result.hasUnresolvedRequiredFields, false);
  assert.strictEqual(result.hasAmbiguousFields, false);
  assert.strictEqual(result.overallConfidence, 1);

  const domicilio = result.fields.find(f => f.field === 'domicilio');
  assert.strictEqual(domicilio?.header, 'Domicilio');
  assert.strictEqual(domicilio?.confidence, 1);
});

test('excelHeaderMatcher - domicilio sin columna reconocible deja overallConfidence en 0 (campo requerido)', () => {
  const result = matchHeadersHeuristically(['Address', 'Price']);

  assert.strictEqual(result.hasUnresolvedRequiredFields, true);
  assert.strictEqual(result.overallConfidence, 0);
  const domicilio = result.fields.find(f => f.field === 'domicilio');
  assert.strictEqual(domicilio?.header, null);
});

test('excelHeaderMatcher - detecta ambigüedad cuando dos headers matchean el mismo campo', () => {
  // "Características" (con tilde) y "Caracteristicas" (sin tilde) matchean AMBAS por distintas
  // ramas del mismo campo (`.includes('característica')` / `.includes('caracteristica')`) — caso
  // real de una agencia con una columna duplicada o mal tipeada.
  const result = matchHeadersHeuristically(['Domicilio', 'Precio', 'Características', 'Caracteristicas']);

  assert.strictEqual(result.hasAmbiguousFields, true);
  const caracteristicas = result.fields.find(f => f.field === 'caracteristicas');
  assert.strictEqual(caracteristicas?.ambiguous, true);
  assert.strictEqual(caracteristicas?.candidates.length, 2);
});

test('excelHeaderMatcher - campos opcionales ausentes no bajan la confianza general', () => {
  const result = matchHeadersHeuristically(['Domicilio', 'Precio']);

  assert.strictEqual(result.overallConfidence, 1, 'Sin expensas/dormitorios/etc. la confianza general (solo sobre domicilio+precio) debe seguir siendo 1.');
  assert.strictEqual(result.hasUnresolvedRequiredFields, false);
});

test('excelHeaderMatcher - headers vacíos no matchean ningún campo', () => {
  const result = matchHeadersHeuristically([]);

  assert.strictEqual(result.overallConfidence, 0);
  assert.ok(result.fields.every(f => f.header === null));
});
