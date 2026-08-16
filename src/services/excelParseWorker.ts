// KAN-137: entry point del worker thread que hace el parseo CPU-bound de Excels subidos
// (`xlsx.read()` + resolución de columnas, ambos síncronos) fuera del hilo principal, para no
// bloquear el event loop mientras se atienden otros tenants. Alcance acotado a propósito (decisión
// validada con el usuario antes de implementar): el worker SOLO hace parseo/validación puros, sin
// red — `syncPropertiesToDatabase` (geocoding + upsert a Supabase, con el cliente autenticado y
// scoped por RLS del tenant, patrón KAN-63) sigue corriendo en el hilo principal como hoy. Un
// worker thread no acelera trabajo I/O-bound, y compartir el cliente Supabase autenticado del
// tenant dentro de un worker hubiera sido más complejo sin ganar nada real.
import { parentPort, isMainThread } from 'worker_threads';
import { peekExcelHeaders, processExcelBufferWithColumnMap, SheetHeaders, ProcessExcelResult } from './excel';
import { ExcelMappingField } from '../utils/excelHeaderMatcher';

export type ExcelParseTaskMessage =
  | { taskId: string; type: 'peekHeaders'; buffer: Buffer }
  | {
      taskId: string;
      type: 'parseWithColumnMap';
      buffer: Buffer;
      mappingsBySignature: Map<string, Partial<Record<ExcelMappingField, string | null>>>;
    };

export type ExcelParseResultMessage =
  | { taskId: string; type: 'result'; result: SheetHeaders[] | ProcessExcelResult }
  | { taskId: string; type: 'error'; message: string };

/**
 * Ejecuta una tarea de parseo y devuelve el mensaje de respuesta correspondiente. Extraída como
 * función pura (sin tocar `parentPort`) para poder testearla directamente desde el hilo principal
 * en `tests/excelParseWorker.test.ts`, sin tener que levantar un `Worker` real por cada caso.
 */
export function runExcelParseTask(message: ExcelParseTaskMessage): ExcelParseResultMessage {
  try {
    if (message.type === 'peekHeaders') {
      return { taskId: message.taskId, type: 'result', result: peekExcelHeaders(message.buffer) };
    }
    const result = processExcelBufferWithColumnMap(message.buffer, message.mappingsBySignature);
    return { taskId: message.taskId, type: 'result', result };
  } catch (error: any) {
    // Un Excel malformado (o cualquier excepción de xlsx.read) no debe tirar abajo el worker —
    // se responde como error de la tarea puntual y el worker queda libre para la siguiente.
    return { taskId: message.taskId, type: 'error', message: error?.message || String(error) };
  }
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (message: ExcelParseTaskMessage) => {
    parentPort!.postMessage(runExcelParseTask(message));
  });
}
