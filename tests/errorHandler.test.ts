import test from 'node:test';
import assert from 'node:assert';
import { globalErrorHandler } from '../src/utils/errorHandler';
import { logger } from '../src/services/logger';

function createMockRes(headersSent = false) {
  const res: any = {
    headersSent,
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

test('globalErrorHandler (KAN-124) loguea el error con logger.error', () => {
  const originalError = logger.error;
  let errorCallArgs: any[] | undefined;
  (logger as any).error = (...args: any[]) => { errorCallArgs = args; };

  try {
    const err = new Error('fallo de prueba');
    const req: any = { path: '/api/test', method: 'GET' };
    const res = createMockRes();
    const next = () => {};

    globalErrorHandler(err, req, res, next);

    assert.ok(errorCallArgs, 'logger.error debe haberse llamado.');
    const [meta] = errorCallArgs!;
    assert.strictEqual(meta.err, 'fallo de prueba', 'El mensaje del error debe quedar en el log.');
    assert.strictEqual(meta.path, '/api/test');
    assert.strictEqual(meta.method, 'GET');
  } finally {
    (logger as any).error = originalError;
  }
});

test('globalErrorHandler (KAN-124) responde 500 con el JSON estándar { error: "Error interno" }, sin exponer el mensaje real', () => {
  const originalError = logger.error;
  (logger as any).error = () => {};

  try {
    const err = new Error('detalle interno sensible que no debe llegar al cliente');
    const req: any = { path: '/api/test', method: 'POST' };
    const res = createMockRes();

    globalErrorHandler(err, req, res, () => {});

    assert.strictEqual(res.statusCode, 500, 'Debe responder con status 500.');
    assert.deepStrictEqual(res.jsonBody, { error: 'Error interno' }, 'El body debe ser exactamente el mensaje estándar, no el mensaje real del error.');
  } finally {
    (logger as any).error = originalError;
  }
});

test('globalErrorHandler (KAN-124) si los headers ya se enviaron, delega a next(err) en vez de responder de nuevo', () => {
  const originalError = logger.error;
  (logger as any).error = () => {};

  try {
    const err = new Error('fallo tardío');
    const req: any = { path: '/api/test', method: 'GET' };
    const res = createMockRes(true);
    let nextCalledWith: any;

    globalErrorHandler(err, req, res, (e: any) => { nextCalledWith = e; });

    assert.strictEqual(res.jsonBody, undefined, 'No debe intentar mandar un JSON nuevo si los headers ya se enviaron.');
    assert.strictEqual(nextCalledWith, err, 'Debe delegar el error a next() cuando headersSent es true.');
  } finally {
    (logger as any).error = originalError;
  }
});
