import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

// KAN-129: regression test — las 12 rutas que antes hacían `error.message || 'fallback'` en la
// respuesta JSON al cliente (filtrando mensajes crudos de Postgres/Supabase, ver auditoria.md)
// ahora solo devuelven el string de fallback genérico. El `error.message` real sigue logueado vía
// `logger.error`/`console.error` unas líneas antes de cada uno de estos — eso está bien y no se
// toca. No hay un harness de Express/supertest en este repo para testear rutas end-to-end, así que
// este test valida el mismo contrato a nivel de código fuente: si alguien reintroduce
// `error.message ||` delante de cualquiera de estos fallbacks, el test falla de inmediato.
// KAN-142: las 12 rutas se repartieron entre src/index.ts y src/routes/*.ts al partir el
// monolito — se concatenan todas las fuentes relevantes para no perder cobertura tras la mudanza.
const ROUTE_SOURCE_FILES = [
  ['src', 'index.ts'],
  ['src', 'routes', 'auth.ts'],
  ['src', 'routes', 'profile.ts'],
  ['src', 'routes', 'upload.ts'],
  // src/routes/search.ts se eliminó (chore: remove orphaned routes/search.ts, 2026-08-24) — era un
  // duplicado nunca montado, el camino real es searchRoutes.ts -> controllers/searchController.ts.
  ['src', 'controllers', 'searchController.ts'],
  ['src', 'routes', 'matches.ts'],
  ['src', 'routes', 'notifications.ts'],
  ['src', 'routes', 'system.ts']
];
const indexSource = ROUTE_SOURCE_FILES
  .map((segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf-8'))
  .join('\n');

// Uno por cada una de las 12 rutas — el fragmento de fallback identifica la línea exacta a revisar.
const CLIENT_FACING_FALLBACKS = [
  'Error interno al obtener el perfil.',
  'Error interno al actualizar el perfil.',
  'Error interno al procesar el archivo.', // aparece 2 veces (POST /api/upload y /api/upload/confirm-mapping)
  'Error interno al procesar este segmento.',
  'Error interno al listar las búsquedas.',
  'Error interno al archivar la búsqueda.',
  'Error interno al reactivar la búsqueda.',
  'Error interno al recuperar matches.',
  'Error interno al recuperar matches entrantes.',
  'Error interno al guardar feedback.',
  'Error interno al suscribir.'
];

function linesContaining(source: string, needle: string): string[] {
  return source.split('\n').filter((line) => line.includes(needle));
}

for (const fallback of CLIENT_FACING_FALLBACKS) {
  test(`KAN-129 - la respuesta al cliente con fallback "${fallback}" no expone error.message`, () => {
    const matchingLines = linesContaining(indexSource, fallback);
    assert.ok(matchingLines.length > 0, `No se encontró ninguna línea con el fallback "${fallback}" — el test quedó desactualizado.`);

    for (const line of matchingLines) {
      assert.ok(
        !line.includes('error.message'),
        `La línea "${line.trim()}" sigue exponiendo error.message al cliente.`
      );
    }
  });
}

test('KAN-129 - los logger.error/console.error de esas mismas rutas siguen logueando error.message (no se perdió el detalle real)', () => {
  // Contraparte del test anterior: confirma que NO se sobre-corrigió sacando el logueo real, solo
  // la respuesta al cliente. Cuenta ocurrencias de "error.message || error" (patrón de logging) en
  // vez de listarlas una por una, porque acompañan a las 12 rutas de arriba con distintos textos.
  const loggingOccurrences = (indexSource.match(/logger\.error\(\{ error: error\.message \|\| error/g) || []).length;
  assert.ok(loggingOccurrences >= 10, 'El logging real de error.message en las rutas afectadas no debería haber desaparecido.');
});
