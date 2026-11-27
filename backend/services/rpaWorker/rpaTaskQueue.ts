import type { RpaTask, RpaResult, RpaRunContext } from './rpaWorkerService';

/**
 * In-process serialiser for RPA execution on the browser worker.
 *
 * Phase C: this queue is NOT the record of an accepted task. executeRpaTask
 * writes a durable rpa_retry_queue row, born claimed by this process, BEFORE a
 * task is pushed here, and finalises it (token-matched) with the result. If the
 * process dies with tasks in this array, their claims expire and are parked as
 * outcome-unknown: never silently lost, never re-run.
 *
 * A definite failure (nothing happened) is re-run once in-process ONLY for an
 * item without a durable claim context; an unknown outcome or a throw is never
 * re-run.
 *
 * Review S-1: an item may carry a run context whose renewClaim() is called
 * immediately before EVERY handler call (first run and the in-process re-run).
 * If it returns false the claim was lost while the item waited: the handler is
 * NOT called and the item resolves { claim_lost, not_attempted }.
 */

type QueueItem = {
  task: RpaTask;
  ctx?: RpaRunContext;
  attempts: number;
  resolve: (value: RpaResult | PromiseLike<RpaResult>) => void;
  reject: (reason?: any) => void;
};

const MAX_ATTEMPTS = 2;

const queue: QueueItem[] = [];
let isProcessing = false;

let currentHandler: ((task: RpaTask, ctx?: RpaRunContext) => Promise<RpaResult>) | null = null;

const processQueue = async () => {
  if (isProcessing || !currentHandler) return;
  isProcessing = true;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;

    try {
      if (item.ctx?.renewClaim) {
        let held = false;
        try { held = await item.ctx.renewClaim(); } catch { held = false; }
        if (!held) {
          item.resolve({ success: false, not_attempted: true, claim_lost: true, error: 'RPA_CLAIM_LOST' });
          continue;
        }
      }
      const result = await currentHandler(item.task, item.ctx);
      // An unknown outcome (the action may already have happened) is never
      // re-run in-process: a second run could double-post or un-like.
      // Review N-a: an item that holds a DURABLE claim (ctx.renewClaim) is never
      // re-run in-process either. The durable row owns the outcome: its first
      // definite failure is returned and finalised as a counted attempt. (A
      // re-run whose lease check then failed would release the row with the
      // real first attempt uncounted.)
      if (!result.success && !result.outcome_unknown && !item.ctx?.renewClaim && item.attempts < MAX_ATTEMPTS) {
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

export const startRpaWorker = (handler: (task: RpaTask, ctx?: RpaRunContext) => Promise<RpaResult>) => {
  currentHandler = handler;
  void processQueue();
};

export const enqueueRpaTask = (task: RpaTask, ctx?: RpaRunContext) => {
  return new Promise<RpaResult>((resolve, reject) => {
    if (!currentHandler) {
      reject(new Error('RPA_WORKER_NOT_STARTED'));
      return;
    }
    queue.push({ task, ctx, attempts: 1, resolve, reject });
    void processQueue();
  });
};
