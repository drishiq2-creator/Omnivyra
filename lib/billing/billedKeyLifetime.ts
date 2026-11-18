/**
 * THE key-lifetime rule for billed requests (b3, 2026-11-18: one shared helper, not a copy per
 * caller). Generalises lib/blog/blogGenerateKey.ts.
 *
 * A key is the server's hold/charge reference for ONE user action:
 * - a click mints a key; a second click while the first is in flight reuses it;
 * - a KNOWN outcome (a 2xx, a refusal, a failure that states its billing, "nothing started")
 *   ENDS the key: the next click is a new request;
 * - an UNKNOWN outcome (connection lost, a 5xx with no billing facts, "still in progress",
 *   "stored result unreadable") KEEPS the key, but ONLY where the route REPLAYS for a key
 *   (`replays: true`). On a route that doesn't replay, a kept key would trap the user in a
 *   permanent same-key refusal (7c), so the key ends there.
 *
 * Never "fix" a kept key by ending it on a lost connection: that turns a lost result into a
 * second charge (lost-response class, docs/billing/BILLED-CLIENT-MIGRATION.md).
 */
import { createBilledActionKeyGate, type IdempotentOperation } from '../idempotency';

/** Refusals where nothing was held or run: the request is definitively over. */
const NOTHING_STARTED = new Set([
  'BILLING_UNAVAILABLE',
  'IDEMPOTENCY_KEY_REQUIRED',
  'BLOG_SWITCH_UNAVAILABLE',
]);

/** "Still running / not readable yet": the same key has a future. */
const STILL_OPEN = new Set([
  'IDEMPOTENCY_IN_PROGRESS',
  'REQUEST_IN_PROGRESS', // c6: activity-workspace generate_variants / refine_variant, first run in flight
  'BLOG_ALREADY_IN_PROGRESS',
  'REPLAY_UNAVAILABLE',
  'BLOG_RESULT_READ_FAILED',
  'BLOG_REFUND_PENDING',
]);

const codeOf = (body: unknown): string =>
  body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : '';

/** A parsed response: is its outcome UNKNOWN (the same key still has a future)? */
export function isUnknownOutcome(status: number, body: unknown): boolean {
  const code = codeOf(body);
  if (STILL_OPEN.has(code)) return true;
  if (status >= 500) {
    if (NOTHING_STARTED.has(code)) return false;
    const billing = body && typeof body === 'object' ? (body as { billing?: unknown }).billing : undefined;
    return !(billing && typeof billing === 'object'); // a failure stating its billing is known
  }
  return false;
}

/* User-facing text comes ONLY from lib/billing/billedResponse (classifyBilledResponse / billedOutcomeText):
   this module decides keep vs end, nothing else (one source of copy). */

export type KeyOutcome = { lost: true } | { lost?: false; status: number; body: unknown };

/** Keep the key? `replays` = the route answers a repeated key from its stored result. */
export function keepKey(outcome: KeyOutcome, rule: { replays: boolean }): boolean {
  if (!rule.replays) return false;
  if (outcome.lost) return true;
  return isUnknownOutcome(outcome.status, outcome.body);
}

export interface BilledKeyLifetime {
  /** The key for this action in `scope` (reused while it is in flight or kept). */
  begin(scope: string): IdempotentOperation;
  /** Record the outcome; ends the key unless it must be kept. Returns true if kept. */
  finish(scope: string, outcome: KeyOutcome): boolean;
}

/**
 * One gate per surface. `replays` must reflect the SERVER (c6 tells us per route); default false
 * means "end on every outcome", today's safe behaviour for non-replaying routes.
 */
export function createBilledKeyLifetime(prefix: string, rule: { replays: boolean }): BilledKeyLifetime {
  const gate = createBilledActionKeyGate(prefix);
  return {
    begin: (scope) => gate.begin(scope || 'default'),
    finish: (scope, outcome) => {
      const kept = keepKey(outcome, rule);
      if (!kept) gate.end(scope || 'default');
      return kept;
    },
  };
}
