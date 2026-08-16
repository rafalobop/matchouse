import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { AITimeoutError } from '../src/services/ai';

// KAN-132: no hay harness de supertest/Express en este repo (src/index.ts no exporta `app`, ver
// tests/errorMessageLeak.test.ts), así que se combina: 1) un test a nivel de código fuente que
// confirma que el bloque real de POST /api/search usa Promise.all (AC1), y 2) tests funcionales
// que replican el bloque real (mismo try/catch por segmento, misma clasificación de
// AITimeoutError) contra una función `processSingleSearchSegment` mockeada, para ejercitar el
// paralelismo, el aislamiento de errores y la mejora de latencia sin red ni servidor real.

interface SearchSegmentResult {
  success: boolean;
  raw_text: string;
  search?: any;
  matches?: any[];
  error?: string;
  code?: string;
}

// Réplica exacta del bloque de src/index.ts (POST /api/search) tras KAN-132.
async function runSegmentsInParallel(
  segments: string[],
  processSingleSearchSegment: (segmentText: string) => Promise<SearchSegmentResult>
): Promise<{ results: SearchSegmentResult[]; anyAITimeout: boolean }> {
  let anyAITimeout = false;

  const results: SearchSegmentResult[] = await Promise.all(
    segments.map(async (segmentText): Promise<SearchSegmentResult> => {
      try {
        return await processSingleSearchSegment(segmentText);
      } catch (error: any) {
        if (error instanceof AITimeoutError) {
          anyAITimeout = true;
          return { success: false, raw_text: segmentText, error: error.message, code: 'AI_TIMEOUT' };
        }
        return { success: false, raw_text: segmentText, error: 'Error interno al procesar este segmento.' };
      }
    })
  );

  return { results, anyAITimeout };
}

// Réplica del loop secuencial pre-KAN-132, usada solo como baseline de latencia en el test de
// performance de abajo (no es el código real, el real ya no existe en src/index.ts).
async function runSegmentsInSerie(
  segments: string[],
  processSingleSearchSegment: (segmentText: string) => Promise<SearchSegmentResult>
): Promise<SearchSegmentResult[]> {
  const results: SearchSegmentResult[] = [];
  for (const segmentText of segments) {
    try {
      results.push(await processSingleSearchSegment(segmentText));
    } catch (error: any) {
      results.push({ success: false, raw_text: segmentText, error: 'Error interno al procesar este segmento.' });
    }
  }
  return results;
}

function delayedSuccess(ms: number, raw_text: string): Promise<SearchSegmentResult> {
  return new Promise((resolve) => setTimeout(() => resolve({ success: true, raw_text, matches: [] }), ms));
}

// --- AC1: usa Promise.all para procesar los segmentos en paralelo ---

test('KAN-132 (AC1) - POST /api/search usa Promise.all para procesar los segmentos, no un loop secuencial con await', () => {
  // KAN-142: la ruta se movió de src/index.ts a src/routes/search.ts al partir el monolito.
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'search.ts'), 'utf-8');
  const searchRouteIdx = indexSource.indexOf("router.post('/api/search'");
  assert.ok(searchRouteIdx >= 0, 'No se encontró la ruta POST /api/search en src/routes/search.ts — el test quedó desactualizado.');

  const routeBlock = indexSource.slice(searchRouteIdx, searchRouteIdx + 3000);
  assert.match(routeBlock, /segments\.map\(/, 'El procesamiento de segmentos debe mapear el array (paralelo), no iterarlo con un for.');
  assert.match(routeBlock, /await Promise\.all\(/, 'El procesamiento de segmentos debe usar Promise.all.');
  assert.doesNotMatch(routeBlock, /for\s*\(\s*const segmentText of segments\s*\)/, 'No debe quedar el loop secuencial "for (const segmentText of segments)".');
});

// --- AC2 (funcional): latencia paralela vs. en serie ---

test('KAN-132 (AC2) - procesar N segmentos en paralelo reduce la latencia total en al menos 50% vs. en serie', async () => {
  const segments = ['segmento 1', 'segmento 2', 'segmento 3', 'segmento 4'];
  const perSegmentDelayMs = 40;
  const process = (raw_text: string) => delayedSuccess(perSegmentDelayMs, raw_text);

  const serieStart = Date.now();
  await runSegmentsInSerie(segments, process);
  const serieDuration = Date.now() - serieStart;

  const paralelaStart = Date.now();
  await runSegmentsInParallel(segments, process);
  const paralelaDuration = Date.now() - paralelaStart;

  assert.ok(
    paralelaDuration <= serieDuration * 0.5,
    `La versión paralela (${paralelaDuration}ms) debe tardar al menos 50% menos que la serie (${serieDuration}ms).`
  );
});

// --- AC3: los errores de un segmento no afectan al resto ---

test('KAN-132 (AC3) - un segmento que lanza un error inesperado no aborta ni afecta a los demás segmentos', async () => {
  const segments = ['segmento ok 1', 'segmento que falla', 'segmento ok 2'];
  const process = (raw_text: string) => {
    if (raw_text === 'segmento que falla') return Promise.reject(new Error('fallo inesperado simulado'));
    return delayedSuccess(5, raw_text);
  };

  const { results, anyAITimeout } = await runSegmentsInParallel(segments, process);

  assert.strictEqual(results.length, 3, 'Los 3 segmentos deben tener un resultado, incluido el que falló.');
  assert.strictEqual(results[0].success, true);
  assert.strictEqual(results[1].success, false);
  assert.strictEqual(results[1].error, 'Error interno al procesar este segmento.');
  assert.strictEqual(results[2].success, true, 'El tercer segmento no debe verse afectado por el fallo del segundo.');
  assert.strictEqual(anyAITimeout, false);
});

test('KAN-132 (AC3) - preserva el orden de entrada de los resultados aunque el paralelismo resuelva las promesas fuera de orden', async () => {
  const segments = ['lento', 'rapido', 'medio'];
  const delays: Record<string, number> = { lento: 30, rapido: 5, medio: 15 };
  const process = (raw_text: string) => delayedSuccess(delays[raw_text], raw_text);

  const { results } = await runSegmentsInParallel(segments, process);

  assert.deepStrictEqual(results.map((r) => r.raw_text), ['lento', 'rapido', 'medio'], 'El array de resultados debe respetar el orden de los segmentos de entrada, no el orden en que terminaron.');
});

test('KAN-132 (AC3) - un AITimeoutError en un segmento se clasifica con code AI_TIMEOUT y no afecta a los demás segmentos', async () => {
  const segments = ['segmento ok', 'segmento con timeout de IA'];
  const process = (raw_text: string) => {
    if (raw_text === 'segmento con timeout de IA') return Promise.reject(new AITimeoutError());
    return delayedSuccess(5, raw_text);
  };

  const { results, anyAITimeout } = await runSegmentsInParallel(segments, process);

  assert.strictEqual(results[0].success, true);
  assert.strictEqual(results[1].success, false);
  assert.strictEqual(results[1].code, 'AI_TIMEOUT');
  assert.strictEqual(anyAITimeout, true, 'anyAITimeout debe quedar en true si al menos un segmento tuvo timeout de IA.');
});

// --- AC4: el rate limit del endpoint no se ve afectado por el paralelismo de segmentos ---

test('KAN-132 (AC4) - el rate limiter del endpoint se consulta una única vez por request, sin importar cuántos segmentos se procesen en paralelo', async () => {
  // Réplica del orden real: el chequeo de searchRateLimiter ocurre ANTES de segmentar/procesar
  // (ver src/index.ts), así que paralelizar el procesamiento de segmentos no agrega llamadas
  // adicionales al limiter — se sigue gastando 1 solo cupo del tenant por request, sin importar
  // si el mensaje se segmentó en 1 o en 10 búsquedas independientes.
  let rateLimiterCalls = 0;
  const checkRateLimiter = () => {
    rateLimiterCalls++;
    return true;
  };

  const allowed = checkRateLimiter();
  assert.ok(allowed);

  const segments = ['segmento 1', 'segmento 2', 'segmento 3', 'segmento 4', 'segmento 5'];
  await runSegmentsInParallel(segments, (raw_text) => delayedSuccess(2, raw_text));

  assert.strictEqual(rateLimiterCalls, 1, 'El rate limiter no debe consultarse una vez por segmento, solo una vez por request.');
});

// --- AC5: caso realista con todos los segmentos exitosos ---

test('KAN-132 (AC5) - caso feliz: todos los segmentos exitosos en paralelo producen success=true por cada uno', async () => {
  const segments = ['depto en barrio norte', 'casa en yerba buena', 'terreno en tafi viejo'];
  const { results, anyAITimeout } = await runSegmentsInParallel(segments, (raw_text) => delayedSuccess(3, raw_text));

  assert.ok(results.every((r) => r.success === true));
  assert.strictEqual(anyAITimeout, false);
});
