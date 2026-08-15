// KAN-128: sanitización de los valores numéricos del snapshot de métricas que reporta el
// dashboard (POST /api/dashboard-metrics, ver src/index.ts) — el body lo arma el cliente, así que
// nunca se loguea tal cual: se acota a un número finito, no negativo y con un tope razonable por
// campo, para que un cliente con un bug (o manipulado a mano) no pueda meter `Infinity`, un string,
// o un número absurdo en los logs estructurados.
export function sanitizeMetricNumber(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, max);
}
