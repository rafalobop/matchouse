// KAN-76: mock mínimo (sin dependencias nuevas, mismo criterio que testServer.ts — el proyecto no
// usa jest/sinon) del cliente encadenable de @supabase/supabase-js (`.from().select().eq()...`).
// Cada método intermedio devuelve el mismo objeto (permite encadenar cualquier combinación real
// usada por los controllers) y el objeto es "thenable" — resuelve al resultado configurado sin
// importar qué métodos se hayan encadenado antes, así que sirve tanto para un `.select().single()`
// como para un `.update().eq().eq().select()`.

export interface FakeQueryResult {
  data?: any;
  error?: any;
  count?: number | null;
}

const CHAIN_METHODS = [
  'select', 'insert', 'update', 'delete', 'upsert',
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'filter',
  'order', 'limit', 'range', 'single', 'maybeSingle'
];

export function chainableResult(result: FakeQueryResult): any {
  const handler: any = {};
  for (const method of CHAIN_METHODS) {
    handler[method] = () => handler;
  }
  handler.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return handler;
}

/**
 * Cliente fake cuyo `.from(table)` devuelve el resultado configurado en `resultsByTable`,
 * indistintamente de la tabla pedida si se pasa un único resultado (`fromHandler` como función
 * para lógica por tabla, ver ejemplos en los tests de rutas).
 */
export function createFakeSupabaseClient(fromHandler: (table: string) => any): any {
  return { from: fromHandler };
}
