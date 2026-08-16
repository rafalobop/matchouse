import * as os from 'os';

// KAN-141: payload del endpoint GET /health (liveness + uso de recursos) — extraído a función pura
// para poder testearlo sin un harness de Express/supertest (este repo no expone `app` en
// src/index.ts, ver tests/errorMessageLeak.test.ts y tests/searchSegmentsParallel.test.ts).
export interface HealthPayload {
  liveness: boolean;
  uptimeSeconds: number;
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
  };
  cpu: {
    loadAvg1m: number;
    loadAvg5m: number;
    loadAvg15m: number;
  };
}

export function buildHealthPayload(): HealthPayload {
  const memoryUsage = process.memoryUsage();
  const [loadAvg1m, loadAvg5m, loadAvg15m] = os.loadavg();

  return {
    liveness: true,
    uptimeSeconds: process.uptime(),
    memory: {
      rssBytes: memoryUsage.rss,
      heapTotalBytes: memoryUsage.heapTotal,
      heapUsedBytes: memoryUsage.heapUsed
    },
    cpu: {
      loadAvg1m,
      loadAvg5m,
      loadAvg15m
    }
  };
}
