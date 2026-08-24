import test from 'node:test';
import assert from 'node:assert';
import { nodeEnvCheckMiddleware, __resetNodeEnvWarningForTests } from '../src/utils/nodeEnvCheck';
import { logger } from '../src/services/logger';

function withPatchedNodeEnv(value: string | undefined, fn: () => void): void {
  const original = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
}

function callMiddleware(): { nextCalled: boolean } {
  const result = { nextCalled: false };
  nodeEnvCheckMiddleware({} as any, {} as any, () => { result.nextCalled = true; });
  return result;
}

test('nodeEnvCheckMiddleware (KAN-124) advierte con logger.warn cuando NODE_ENV no es "production"', () => {
  __resetNodeEnvWarningForTests();
  const originalWarn = logger.warn;
  let warnCalled = false;
  (logger as any).warn = (..._args: any[]) => { warnCalled = true; };

  try {
    withPatchedNodeEnv('development', () => {
      callMiddleware();
    });
  } finally {
    (logger as any).warn = originalWarn;
  }

  assert.strictEqual(warnCalled, true, 'Con NODE_ENV distinto de "production", el middleware debe advertir vía logger.warn.');
});

test('nodeEnvCheckMiddleware (KAN-124) no advierte cuando NODE_ENV es "production"', () => {
  __resetNodeEnvWarningForTests();
  const originalWarn = logger.warn;
  let warnCalled = false;
  (logger as any).warn = (..._args: any[]) => { warnCalled = true; };

  try {
    withPatchedNodeEnv('production', () => {
      callMiddleware();
    });
  } finally {
    (logger as any).warn = originalWarn;
  }

  assert.strictEqual(warnCalled, false, 'Con NODE_ENV="production" el middleware no debe advertir.');
});

test('nodeEnvCheckMiddleware (KAN-124) siempre llama a next(), sin bloquear el request', () => {
  __resetNodeEnvWarningForTests();
  const { nextCalled } = callMiddleware();
  assert.strictEqual(nextCalled, true, 'El middleware nunca debe cortar la cadena de middlewares — solo advierte, no bloquea.');
});

test('nodeEnvCheckMiddleware (KAN-124) solo advierte una vez por proceso, no en cada request', () => {
  __resetNodeEnvWarningForTests();
  const originalWarn = logger.warn;
  let warnCallCount = 0;
  (logger as any).warn = (..._args: any[]) => { warnCallCount++; };

  try {
    withPatchedNodeEnv('development', () => {
      callMiddleware();
      callMiddleware();
      callMiddleware();
    });
  } finally {
    (logger as any).warn = originalWarn;
  }

  assert.strictEqual(warnCallCount, 1, 'El warning no debe repetirse en cada request — una sola vez por proceso.');
});
