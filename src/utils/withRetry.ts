// KAN-79: utilidad genérica de reintentos con backoff exponencial. Pensada para I/O de
// notificación (push/email, ver services/notifications.ts) — no para llamadas a IA, que ya
// tienen su propio timeout en withTimeout.ts. Por eso los defaults son chicos (pocos intentos,
// backoff corto): una notificación fire-and-forget no debe demorar minutos reintentando.

export interface WithRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, options: WithRetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 150;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await delay(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError;
}
