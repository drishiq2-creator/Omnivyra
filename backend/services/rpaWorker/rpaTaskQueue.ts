import type { RpaTask, RpaResult } from './rpaWorkerService';

type QueueItem = {
  task: RpaTask;
  attempts: number;
  resolve: (value: RpaResult | PromiseLike<RpaResult>) => void;
  reject: (reason?: any) => void;
};

const MAX_ATTEMPTS = 2;

const queue: QueueItem[] = [];
let isProcessing = false;

let currentHandler: ((task: RpaTask) => Promise<RpaResult>) | null = null;

const processQueue = async () => {
  if (isProcessing || !currentHandler) return;
  isProcessing = true;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;

    try {
      const result = await currentHandler(item.task);
      // An unknown outcome (the action may already have happened) is never
      // re-run in-process: a second run could double-post or un-like.
      if (!result.success && !result.outcome_unknown && item.attempts < MAX_ATTEMPTS) {
        queue.push({ ...item, attempts: item.attempts + 1 });
        continue;
      }
      item.resolve(result);
    } catch (error: any) {
      // A throw from the handler can come mid-action: unknown outcome, not a
      // failure, and not retried (previously re-run once, then rejected).
      const msg = String(error?.message || error || 'RPA_HANDLER_THREW').split(/\r?\n/)[0].slice(0, 300);
      item.resolve({ success: false, outcome_unknown: true, error: `RPA_OUTCOME_UNKNOWN:${msg}` });
    }
  }

  isProcessing = false;
  if (queue.length > 0) {
    void processQueue();
  }
};

export const startRpaWorker = (handler: (task: RpaTask) => Promise<RpaResult>) => {
  currentHandler = handler;
  void processQueue();
};

export const enqueueRpaTask = (task: RpaTask) => {
  return new Promise<RpaResult>((resolve, reject) => {
    if (!currentHandler) {
      reject(new Error('RPA_WORKER_NOT_STARTED'));
      return;
    }
    queue.push({ task, attempts: 1, resolve, reject });
    void processQueue();
  });
};
