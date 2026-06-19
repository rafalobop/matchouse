import { logger } from '../services/logger';

type QueueTask = () => Promise<void>;

export class AsyncMessageQueue {
  private queues = new Map<string, QueueTask[]>();
  private processingStates = new Map<string, boolean>();
  private delayMs: number;

  constructor(delayMs = 4500) {
    this.delayMs = delayMs;
  }

  enqueue(task: QueueTask, tenantId: string = 'default') {
    if (!this.queues.has(tenantId)) {
      this.queues.set(tenantId, []);
    }
    const q = this.queues.get(tenantId)!;
    q.push(task);
    
    logger.info({ queueLength: q.length, tenantId }, '[QUEUE] Nuevo mensaje encolado para el tenant');
    this.processNext(tenantId);
  }

  private async processNext(tenantId: string) {
    if (this.processingStates.get(tenantId)) return;
    
    const q = this.queues.get(tenantId) || [];
    if (q.length === 0) return;

    this.processingStates.set(tenantId, true);
    const task = q.shift();

    if (task) {
      try {
        await task();
      } catch (error: any) {
        logger.error({ error: error.message || error, tenantId }, '[QUEUE] Error al ejecutar tarea de la cola para el tenant');
      }
    }

    // Esperar el delay configurado antes de procesar el siguiente mensaje para este tenant
    setTimeout(() => {
      this.processingStates.set(tenantId, false);
      this.processNext(tenantId);
    }, this.delayMs);
  }
}

export const messageQueue = new AsyncMessageQueue();
