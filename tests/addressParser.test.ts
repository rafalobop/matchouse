import test from 'node:test';
import assert from 'node:assert';
import { buildGeocodableQuery } from '../src/utils/addressParser';

test('addressParser - normaliza un domicilio simple agregando contexto de provincia/país', () => {
  const result = buildGeocodableQuery({ address: 'Av. Aconquija 1200' });

  assert.strictEqual(result.normalized, 'Av. Aconquija 1200, Tucumán, Argentina');
  assert.strictEqual(result.hasStreetNumber, true);
  assert.strictEqual(result.isRouteAddress, false);
});

// Regresión (QA pre-beta, 2026-10-02): zone_display_name salía de sheetOperacionYZona, un
// heurístico de 2 valores a partir del nombre de la pestaña del Excel que no conoce Tafí Viejo,
// Tafí del Valle, etc. Cuando la localidad adivinada contradecía la dirección real, Nominatim no
// devolvía ningún resultado (verificado en vivo). No debe volver a mandarse como contexto.
test('addressParser - ya no agrega zone_display_name al contexto (causaba 0 resultados en Nominatim cuando contradecía la calle real)', () => {
  const result = buildGeocodableQuery({ address: 'San Martín 100, Tafí Viejo' } as any);

  assert.strictEqual(result.normalized, 'San Martín 100, Tafí Viejo, Tucumán, Argentina');
  assert.ok(!result.normalized.includes('San Miguel de Tucumán'), 'No debe inventar una localidad que contradiga la calle real.');
});

test('addressParser - domicilio sin numeración (s/n) se marca y se limpia de la consulta', () => {
  const result = buildGeocodableQuery({ address: 'Camino Real s/n' });

  assert.strictEqual(result.hasStreetNumber, false);
  assert.ok(!result.normalized.toLowerCase().includes('s/n'), 'La consulta al geocoder no debe incluir "s/n".');
  assert.ok(result.normalized.startsWith('Camino Real'));
});

test('addressParser - detecta domicilios de ruta/kilómetro', () => {
  const result = buildGeocodableQuery({ address: 'Ruta 9 Km 12' });

  assert.strictEqual(result.isRouteAddress, true);
});

test('addressParser - un domicilio con intersección se reduce a la primera vía nombrada', () => {
  const result = buildGeocodableQuery({ address: 'Av. Aconquija esq. Av. Perón' });

  assert.ok(result.normalized.startsWith('Av. Aconquija'));
  assert.ok(!result.normalized.toLowerCase().includes('perón'), 'No debe incluir la segunda calle de la intersección.');
});

test('addressParser - colapsa espacios extra y recorta el domicilio', () => {
  const result = buildGeocodableQuery({ address: '  Calle   Falsa   123  ' });

  assert.ok(result.normalized.startsWith('Calle Falsa 123'));
});

test('addressParser - funciona sin zone_display_name', () => {
  const result = buildGeocodableQuery({ address: 'Calle Falsa 123' });

  assert.strictEqual(result.normalized, 'Calle Falsa 123, Tucumán, Argentina');
});
