import test from 'node:test';
import assert from 'node:assert';
import { detectTipoPropiedad } from '../src/services/sheets';

test('Sheets Service - detectTipoPropiedad debería clasificar correctamente', () => {
  const tipo1 = detectTipoPropiedad('Dpto sobre Av. Mate de Luna', '', '');
  const tipo2 = detectTipoPropiedad('Lote en San Pablo', '', '');
  const tipo3 = detectTipoPropiedad('Casa con pileta', '', '');

  assert.strictEqual(tipo1, 'departamento', 'Debería detectar departamento.');
  assert.strictEqual(tipo2, 'terreno', 'Debería detectar lote como terreno.');
  assert.strictEqual(tipo3, 'casa', 'Debería detectar casa.');
});
