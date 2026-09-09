import * as os from 'os';
import { supabase } from '../services/supabase';

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

export interface SupabaseConnectivityResult {
  ok: boolean;
  error?: string;
}

// KAN-321: a diferencia de buildHealthPayload/GET /health (liveness pura, sin dependencias
// externas a propósito, ver comentario en src/app.ts KAN-83), esto SÍ toca Supabase — GET
// /health/ready necesita distinguir "el proceso Node está arriba" de "el proceso puede servir
// tráfico real" (que depende de la DB). Query más barata posible: HEAD + count sobre una tabla
// chica, sin traer filas. Try/catch cubre tanto el rechazo async normal del SDK como una excepción
// sincrónica (ej. si faltan credenciales de Supabase: `supabase` es un Proxy que tira al primer
// uso real, ver src/services/supabase.ts#createMissingCredentialsStub).
export async function checkSupabaseConnectivity(): Promise<SupabaseConnectivityResult> {
  try {
    const { error } = await supabase.from('profiles').select('id', { count: 'exact', head: true }).limit(1);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
