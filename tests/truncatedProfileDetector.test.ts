import test from 'node:test';
import assert from 'node:assert';
import { isTruncatedFullName } from '../src/utils/truncatedProfileDetector';

test('truncatedProfileDetector - detecta full_name igual al local-part del email (el bug real de KAN-90)', () => {
  assert.strictEqual(isTruncatedFullName('juan.perez', 'juan.perez@gmail.com'), true);
});

test('truncatedProfileDetector - no marca un full_name real como truncado', () => {
  assert.strictEqual(isTruncatedFullName('Juan Pérez', 'juan.perez@gmail.com'), false);
});

test('truncatedProfileDetector - no marca un full_name vacio (perfil recien creado, sin completar aun)', () => {
  assert.strictEqual(isTruncatedFullName('', 'juan.perez@gmail.com'), false);
});

test('truncatedProfileDetector - no marca null/undefined', () => {
  assert.strictEqual(isTruncatedFullName(null, 'juan.perez@gmail.com'), false);
  assert.strictEqual(isTruncatedFullName(undefined, 'juan.perez@gmail.com'), false);
  assert.strictEqual(isTruncatedFullName('juan.perez', null), false);
  assert.strictEqual(isTruncatedFullName('juan.perez', undefined), false);
});

test('truncatedProfileDetector - es sensible a mayusculas/minusculas (coincidencia exacta con el local-part real)', () => {
  // El bug original hace `email.split('@')[0]` tal cual, sin normalizar case - una coincidencia
  // parcial por case no debe generar falsos positivos sobre un nombre real que casualmente
  // coincida en minusculas.
  assert.strictEqual(isTruncatedFullName('Juan.Perez', 'juan.perez@gmail.com'), false);
});
