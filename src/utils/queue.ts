import { logger } from '../services/logger';

type QueueTask = () => Promise<void>;

export class AsyncMessageQueue {
  private queue: QueueTask[] = [];
  private isProcessing = false;
  private delayMs: number;

  constructor(delayMs = 4500) {
    this.delayMs = delayMs;
  }

  enqueue(task: QueueTask, tenantId?: string) {
    this.queue.push(task);
    logger.info({ queueLength: this.queue.length, tenantId }, '[QUEUE] Nuevo mensaje encolado');
    this.processNext();
  }

  private async processNext() {
    if (this.isProcessing) return;
    if (this.queue.length === 0) return;

    this.isProcessing = true;
    const task = this.queue.shift();

    if (task) {
      try {
        await task();
      } catch (error: any) {
        logger.error({ error: error.message || error }, '[QUEUE] Error al ejecutar tarea de la cola');
      }
    }

    // Esperar el delay configurado antes de procesar el siguiente mensaje (Rate Limit protection)
    setTimeout(() => {
      this.isProcessing = false;
      this.processNext();
    }, this.delayMs);
  }
}

export const messageQueue = new AsyncMessageQueue();
