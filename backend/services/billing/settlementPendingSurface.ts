/**
 * settlementPending reaches EVERY billed HTTP response (b3 ruling 2026-11-18: one contract everywhere - 200 + the
 * field - with a structural guarantee that no wirePhase2Route caller drops it).
 *
 * When billed work SUCCEEDED but the settle outcome is unknown, the engine returns the result with a SettlementPending
 * marker and leaves the hold reserved for resolution. The customer must be able to see that state (owner contract:
 * HTTP 200 + `settlementPending: { code: 'CREDIT_SETTLE_AMBIGUOUS' }`), or a later resolver charge looks unexplained.
 *
 * Mechanism: the route factory (lib/platform/routeFactory createApiRoute) runs every handler inside
 * runWithSettlementSurface(res, ...). That opens a DEDICATED AsyncLocalStorage scope - not the request context, which
 * mergeRequestContext() can swap with enterWith() - holding a box, and wraps res.json: on a 2xx, a plain-object body
 * gains `settlementPending` (never overwriting one the route set itself); any other body (array, primitive) carries
 * the X-Settlement-Pending header instead, so its shape is unchanged. wirePhase2Route calls reportSettlementPending.
 * Outside any scope the report is counted + logged (settlement_pending_unsurfaced_total), never silent.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '../logger';
import { incrCounter } from './billingMetrics';

export const SETTLEMENT_PENDING_HEADER = 'X-Settlement-Pending';
export type SurfacedSettlementPending = { code: 'CREDIT_SETTLE_AMBIGUOUS' };

type Box = { pending?: SurfacedSettlementPending };
const scope = new AsyncLocalStorage<Box>();

type JsonRes = { statusCode?: number; json: (body: any) => any; setHeader?: (n: string, v: string) => any; headersSent?: boolean };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Run a route handler with settlementPending surfacing on `res`. */
export function runWithSettlementSurface<T>(res: JsonRes, fn: () => T): T {
  const box: Box = {};
  try {
    const original = res.json.bind(res);
    res.json = (body: any) => {
      const status = Number(res.statusCode ?? 200);
      if (box.pending && status >= 200 && status < 300) {
        if (isPlainObject(body)) {
          if (!('settlementPending' in body)) body = { ...body, settlementPending: box.pending };
        } else {
          try { if (!res.headersSent) res.setHeader?.(SETTLEMENT_PENDING_HEADER, box.pending.code); } catch { /* never break the response */ }
        }
      }
      return original(body);
    };
  } catch {
    /* a response object we cannot wrap: the report below still counts + logs */
  }
  return scope.run(box, fn);
}

/** Called by the billing layer when finished work has an ambiguous settle. True when it will reach the response. */
export function reportSettlementPending(context: Record<string, unknown> = {}): boolean {
  const box = scope.getStore();
  if (box) {
    box.pending = { code: 'CREDIT_SETTLE_AMBIGUOUS' };
    return true;
  }
  incrCounter('settlement_pending_unsurfaced_total');
  logger.error('settlement_pending_unsurfaced', context);
  return false;
}
