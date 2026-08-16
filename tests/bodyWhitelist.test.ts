import test from 'node:test';
import assert from 'node:assert';
import { validateBodyWhitelist, jsonBodyParseErrorHandler, JSON_BODY_SIZE_LIMIT } from '../src/utils/bodyWhitelist';

function createMockRes() {
  const res: any = {
    statusCode: undefined as number | undefined,
    jsonBody: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.jsonBody = body;
      return res;
    }
  };
  return res;
}

// --- validateBodyWhitelist ---

test('BodyWhitelist (KAN-134) - body con solo campos permitidos no genera error', () => {
  const result = validateBodyWhitelist({ first_name: 'Ana', last_name: 'Pérez' }, ['first_name', 'last_name']);
  assert.strictEqual(result, null);
});

test('BodyWhitelist (KAN-134) - un campo inesperado se rechaza con mensaje que lo nombra', () => {
  const result = validateBodyWhitelist({ text: 'busco depto', admin: true }, ['text']);
  assert.ok(result, 'Debe devolver un mensaje de error.');
  assert.match(result!, /admin/);
});

test('BodyWhitelist (KAN-134) - varios campos inesperados se listan todos', () => {
  const result = validateBodyWhitelist({ status: 'ACCEPTED', reason: 'ok', extra1: 1, extra2: 2 }, ['status', 'reason']);
  assert.ok(result);
  assert.match(result!, /extra1/);
  assert.match(result!, /extra2/);
});

test('BodyWhitelist (KAN-134) - body vacío ({}) nunca genera error, cualquiera sea la whitelist', () => {
  assert.strictEqual(validateBodyWhitelist({}, ['a', 'b']), null);
  assert.strictEqual(validateBodyWhitelist({}, []), null);
});

test('BodyWhitelist (KAN-134) - body undefined/null/array/primitivo no es responsabilidad de este chequeo (devuelve null)', () => {
  assert.strictEqual(validateBodyWhitelist(undefined, ['a']), null);
  assert.strictEqual(validateBodyWhitelist(null, ['a']), null);
  assert.strictEqual(validateBodyWhitelist(['a', 'b'], ['a']), null);
  assert.strictEqual(validateBodyWhitelist('texto plano', ['a']), null);
});

test('BodyWhitelist (KAN-134) - la whitelist vacía rechaza cualquier campo presente', () => {
  const result = validateBodyWhitelist({ points: [] }, []);
  assert.ok(result);
  assert.match(result!, /points/);
});

// --- jsonBodyParseErrorHandler ---

test('jsonBodyParseErrorHandler (KAN-134) - error de body-parser "entity.too.large" responde 413 mencionando el límite', () => {
  const err: any = new Error('request entity too large');
  err.type = 'entity.too.large';
  const res = createMockRes();
  let nextCalled = false;

  jsonBodyParseErrorHandler(err, {} as any, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 413);
  assert.match(res.jsonBody.error, new RegExp(JSON_BODY_SIZE_LIMIT));
  assert.strictEqual(nextCalled, false, 'No debe delegar a next() si ya respondió.');
});

test('jsonBodyParseErrorHandler (KAN-134) - JSON malformado ("entity.parse.failed") responde 400', () => {
  const err: any = new Error('Unexpected token');
  err.type = 'entity.parse.failed';
  const res = createMockRes();

  jsonBodyParseErrorHandler(err, {} as any, res, () => {});

  assert.strictEqual(res.statusCode, 400);
  assert.ok(res.jsonBody.error);
});

test('jsonBodyParseErrorHandler (KAN-134) - un SyntaxError sin "type" (body-parser en otras versiones) también responde 400', () => {
  const err = new SyntaxError('Unexpected token in JSON');
  const res = createMockRes();

  jsonBodyParseErrorHandler(err, {} as any, res, () => {});

  assert.strictEqual(res.statusCode, 400);
});

test('jsonBodyParseErrorHandler (KAN-134) - un error no relacionado con el body-parser se delega a next(), sin responder acá', () => {
  const err = new Error('fallo de otra parte del pipeline');
  const res = createMockRes();
  let nextCalledWith: any;

  jsonBodyParseErrorHandler(err, {} as any, res, (e: any) => { nextCalledWith = e; });

  assert.strictEqual(res.statusCode, undefined, 'No debe responder si el error no es de body-parser.');
  assert.strictEqual(nextCalledWith, err);
});
