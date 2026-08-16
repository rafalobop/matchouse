import test from 'node:test';
import assert from 'node:assert';
import { Writable } from 'node:stream';
import pino from 'pino';
import { PII_LOG_FIELDS, PII_REDACT_CENSOR, buildLogRedactionConfig } from '../src/config/logRedaction';

function createCapturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    }
  });
  const capturingLogger = pino({ redact: buildLogRedactionConfig() }, stream);
  return { capturingLogger, lines };
}

test('logRedaction (KAN-135) PII_LOG_FIELDS incluye los campos de PII detectados en el análisis de logs reales', () => {
  for (const field of ['email', 'adminEmail', 'ip', 'address', 'query', 'raw', 'texto', 'segmentText']) {
    assert.ok(PII_LOG_FIELDS.includes(field), `PII_LOG_FIELDS debería incluir "${field}".`);
  }
});

test('logRedaction (KAN-135) buildLogRedactionConfig usa censura por valor, no remove, para no romper la forma del log', () => {
  const config = buildLogRedactionConfig();
  assert.strictEqual(config.censor, PII_REDACT_CENSOR);
  assert.deepStrictEqual(config.paths.sort(), [...PII_LOG_FIELDS].sort());
});

test('logRedaction (KAN-135) cada llamada devuelve un array de paths nuevo, sin compartir estado mutable', () => {
  const configA = buildLogRedactionConfig();
  const configB = buildLogRedactionConfig();
  configA.paths.push('otra-key-de-prueba');
  assert.strictEqual(configB.paths.includes('otra-key-de-prueba'), false);
});

test('logRedaction (KAN-135) redacta emails en la salida real de un logger Pino', () => {
  const { capturingLogger, lines } = createCapturingLogger();
  capturingLogger.info({ email: 'agente@brokaza.com', ip: '190.190.1.1' }, '[AUTH] Solicitud de magic link recibida');

  assert.strictEqual(lines.length, 1);
  assert.ok(!lines[0].includes('agente@brokaza.com'), 'El email en texto plano no debería aparecer en la salida del log.');
  assert.ok(!lines[0].includes('190.190.1.1'), 'La IP en texto plano no debería aparecer en la salida del log.');

  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.email, PII_REDACT_CENSOR);
  assert.strictEqual(parsed.ip, PII_REDACT_CENSOR);
});

test('logRedaction (KAN-135) redacta domicilios y texto libre de ubicación', () => {
  const { capturingLogger, lines } = createCapturingLogger();
  capturingLogger.warn(
    { address: 'Av. Siempre Viva 742', query: 'Av. Siempre Viva 742, Tucumán', texto: 'cerca de plaza independencia' },
    '[EXCEL] Propiedad geocodificada'
  );

  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.address, PII_REDACT_CENSOR);
  assert.strictEqual(parsed.query, PII_REDACT_CENSOR);
  assert.strictEqual(parsed.texto, PII_REDACT_CENSOR);
});

test('logRedaction (KAN-135) no redacta campos no sensibles (interoperabilidad con consumidores de logs)', () => {
  const { capturingLogger, lines } = createCapturingLogger();
  capturingLogger.info({ tenantId: 'tenant-123', searchId: 'search-456', matchCount: 3 }, '[BUSQUEDA] Match encontrado');

  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.tenantId, 'tenant-123');
  assert.strictEqual(parsed.searchId, 'search-456');
  assert.strictEqual(parsed.matchCount, 3);
});
