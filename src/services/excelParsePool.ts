// KAN-137: pool de worker threads persistentes para el parseo de Excels subidos (ver
// excelParseWorker.ts para qué corre adentro de cada worker y por qué el alcance está acotado a
// solo parseo/validación, sin red). Pool chico y acotado a propósito (default 2, ver
// config.excelParsePoolSize) — la instancia real de Railway tiene 2 vCPU/1GB compartidos con el
// resto del proceso, así que spawnear un Worker sin límite por cada upload concurrente podría
// agotar CPU/RAM. Workers persistentes (no uno por tarea) para evitar el costo de arranque de un
// Worker nuevo (~decenas de ms) en cada subida.
import { Worker } from 'worker_threads';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config/env';
import { logger } from './logger';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import { SheetHeaders, ProcessExcelResult } from './excel';
import { ExcelMappingField } from '../utils/excelHeaderMatcher';
import type { ExcelParseTaskMessage, ExcelParseResultMessage } from './excelParseWorker';

// El mismo archivo corre bajo ts-node (dev/tests, `__filename` termina en .ts) y compilado (prod,
// `dist/services/excelParsePool.js`, `__filename` termina en .js) — el Worker necesita el path y
// el loader correctos para cada caso. Mismo criterio que cualquier otro script standalone del
// proyecto que se invoca con ts-node en dev (ver package.json:scripts).
const IS_TS_NODE = __filename.endsWith('.ts');
const WORKER_PATH = path.join(__dirname, IS_TS_NODE ? 'excelParseWorker.ts' : 'excelParseWorker.js');
const WORKER_EXEC_ARGV = IS_TS_NODE ? ['-r', 'ts-node/register'] : [];

interface PendingTask {
  resolve: (result: SheetHeaders[] | ProcessExcelResult) => void;
  reject: (error: Error) => void;
}

interface QueuedTask {
  message: ExcelParseTaskMessage;
  pending: PendingTask;
}

interface PoolWorker {
  worker: Worker;
  busyTaskId: string | null;
}

let poolWorkers: PoolWorker[] = [];
const pendingTasks = new Map<string, PendingTask>();
const taskQueue: QueuedTask[] = [];
// Distingue un `worker.terminate()` intencional de `stopExcelParsePool()` de una caída real —
// sin esto, el handler de 'exit' de cada worker terminado por el shutdown se dispara igual (con
// código != 0) y respawnea un reemplazo, dejando `stopExcelParsePool()` sin efecto real (el pool
// nunca baja a 0 workers, el proceso nunca puede salir limpio). El terminate() puntual de un
// worker colgado por timeout NO usa esta bandera — ahí sí queremos que se respawnee.
let isShuttingDown = false;

function spawnWorker(): PoolWorker {
  const worker = new Worker(WORKER_PATH, { execArgv: WORKER_EXEC_ARGV });
  const record: PoolWorker = { worker, busyTaskId: null };

  worker.on('message', (message: ExcelParseResultMessage) => {
    const pending = pendingTasks.get(message.taskId);
    pendingTasks.delete(message.taskId);
    record.busyTaskId = null;
    if (pending) {
      if (message.type === 'result') {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.message));
      }
    }
    dispatchNext(record);
  });

  // Un worker que crashea (excepción no capturada, corrupción de memoria, etc.) o termina
  // inesperadamente no debe dejar el pool degradado para siempre ni las tareas siguientes
  // colgadas — se rechaza la tarea en curso (si había una) y se respawnea un reemplazo (AC4: el
  // rendimiento general del resto del sistema no se ve afectado por un error puntual del worker).
  worker.on('error', (err: Error) => {
    logger.error({ error: err.message }, '[EXCEL PARSE POOL] Worker de parseo tiró un error.');
    failCurrentTask(record, err);
  });

  worker.on('exit', (code: number) => {
    poolWorkers = poolWorkers.filter(w => w !== record);
    if (isShuttingDown) return;

    if (code !== 0) {
      logger.error({ code }, '[EXCEL PARSE POOL] Worker de parseo terminó inesperadamente, respawneando.');
      failCurrentTask(record, new Error(`El worker de parseo terminó inesperadamente (código ${code}).`));
    }
    if (poolWorkers.length < config.excelParsePoolSize) {
      poolWorkers.push(spawnWorker());
      dispatchNext();
    }
  });

  return record;
}

function failCurrentTask(record: PoolWorker, err: Error): void {
  if (!record.busyTaskId) return;
  const pending = pendingTasks.get(record.busyTaskId);
  pendingTasks.delete(record.busyTaskId);
  record.busyTaskId = null;
  pending?.reject(err);
}

function dispatchNext(preferredWorker?: PoolWorker): void {
  if (taskQueue.length === 0) return;
  const idleWorker = preferredWorker && !preferredWorker.busyTaskId
    ? preferredWorker
    : poolWorkers.find(w => !w.busyTaskId);
  if (!idleWorker) return;

  const next = taskQueue.shift();
  if (!next) return;

  idleWorker.busyTaskId = next.message.taskId;
  pendingTasks.set(next.message.taskId, next.pending);
  idleWorker.worker.postMessage(next.message);
}

/** Idempotente — llamarlo más de una vez (ej. tests que no comparten estado del proceso) no duplica workers. */
export function initExcelParsePool(size: number = config.excelParsePoolSize): void {
  if (poolWorkers.length > 0) return;
  isShuttingDown = false;
  for (let i = 0; i < size; i++) {
    poolWorkers.push(spawnWorker());
  }
}

export async function stopExcelParsePool(): Promise<void> {
  isShuttingDown = true;
  await Promise.all(poolWorkers.map(w => w.worker.terminate()));
  poolWorkers = [];
  taskQueue.length = 0;
  pendingTasks.clear();
}

function runTask(message: ExcelParseTaskMessage): Promise<SheetHeaders[] | ProcessExcelResult> {
  initExcelParsePool(); // no-op si ya está inicializado — red de seguridad para no depender de que main() haya corrido antes (ej. tests).

  const taskPromise = new Promise<SheetHeaders[] | ProcessExcelResult>((resolve, reject) => {
    taskQueue.push({ message, pending: { resolve, reject } });
    dispatchNext();
  });

  return withTimeout(taskPromise, config.excelParseTimeoutMs, `excel parse worker (${message.type})`).catch((err: Error) => {
    if (err instanceof TimeoutError) {
      // El worker que tenía esta tarea puede seguir colgado indefinidamente — se termina (el
      // handler de 'exit' respawnea el reemplazo) en vez de dejarlo "ocupado" para siempre.
      const stuckWorker = poolWorkers.find(w => w.busyTaskId === message.taskId);
      pendingTasks.delete(message.taskId);
      stuckWorker?.worker.terminate();
    }
    throw err;
  });
}

export function peekExcelHeadersInWorker(buffer: Buffer): Promise<SheetHeaders[]> {
  return runTask({ taskId: randomUUID(), type: 'peekHeaders', buffer }) as Promise<SheetHeaders[]>;
}

export function parseExcelWithColumnMapInWorker(
  buffer: Buffer,
  mappingsBySignature: Map<string, Partial<Record<ExcelMappingField, string | null>>>
): Promise<ProcessExcelResult> {
  return runTask({ taskId: randomUUID(), type: 'parseWithColumnMap', buffer, mappingsBySignature }) as Promise<ProcessExcelResult>;
}

/** Solo para tests: cantidad de workers vivos en el pool. */
export function excelParsePoolSize(): number {
  return poolWorkers.length;
}
