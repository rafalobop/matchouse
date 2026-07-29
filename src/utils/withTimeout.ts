// KAN-70: extraído de src/index.ts (nació ahí para las llamadas a Supabase Auth en
// tenantAuthMiddleware/session/exchange-token) a un módulo compartido para que src/services/ai.ts
// pueda reusarlo sin depender de index.ts. Comportamiento sin cambios.

/**
 * Error específico lanzado cuando una promesa no resuelve dentro del plazo de `withTimeout`.
 * Los llamadores pueden distinguirlo de otros errores (`instanceof TimeoutError` o
 * `error.name === 'TimeoutError'`) para responder de forma apropiada (ej. un mensaje de UI
 * distinto al de un error genérico).
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Ejecuta una promesa con un tiempo límite. Evita que un request quede colgado
 * indefinidamente (spinner infinito en el cliente) ante fallos de red/DNS o proveedores
 * externos que no responden.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`Timeout de ${ms}ms esperando: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
