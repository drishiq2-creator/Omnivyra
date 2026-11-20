/**
 * Deterministic settlement-expiry sweeper (SANDBOX-ONLY).
 *
 * Completes the normalized settlement lifecycle: a checkout session that is
 * stuck in a non-terminal state (`created` / `pending`) past its expiry
 * threshold is transitioned to the terminal `expired` state.
 *
 * GUARANTEES:
 *   - Deterministic — the outcome is a pure function of (candidate set, policy,
 *     now). No randomness, no provider call.
 *   - Idempotent — the expiry event id is deterministic per session, so a
 *     re-sweep collides on the append-only event ledger; and an already-expired
 *     (terminal) session is never returned as a candidate. Triple-guarded by
 *     the forward-only state machine (canTransition).
 *   - Terminal-safe — only `created` / `pending` sessions are candidates; a
 *     `succeeded` / `failed` / `cancelled` / `expired` session is NEVER touched.
 *   - Append-only — every expiry writes one billing_settlement_events row, the
 *     same ledger reconciliation uses.
 *   - PRICING-BLIND — no amount is read, computed, or persisted.
 *
 * Provider-agnostic: the expiry policy is normalized (one threshold per
 * lifecycle state, applied uniformly across all providers) — no provider-
 * specific lifecycle vocabulary leaks in.
 *
 * NO live settlement, NO wallet funding, NO credit issuance, NO entitlement
 * activation, NO invoicing, NO ledger mutation.
 */

import { logger } from '../../logger';
import { canTransition, type SettlementState } from './paymentSettlementOrchestrator';
import {
  findSettlementSweepCandidates as realFindSettlementSweepCandidates,
  recordSettlementEvent as realRecordSettlementEvent,
  applySettlementTransition as realApplySettlementTransition,
} from './checkoutSessionStore';

// ── expiry policy ───────────────────────────────────────────────────────────
export interface ExpiryPolicy {
  /** A `created` session older than this (ms) is expired. */
  createdMaxAgeMs: number;
  /** A `pending` session older than this (ms) is expired. */
  pendingMaxAgeMs: number;
}

const DEFAULT_CREATED_MAX_AGE_MINUTES = 30;
const DEFAULT_PENDING_MAX_AGE_MINUTES = 120;

/**
 * Resolve the normalized, provider-agnostic expiry policy. Thresholds are
 * configurable via SETTLEMENT_EXPIRY_CREATED_MINUTES /
 * SETTLEMENT_EXPIRY_PENDING_MINUTES; an explicit override wins (for tests).
 */
export function resolveExpiryPolicy(override?: Partial<ExpiryPolicy>): ExpiryPolicy {
  const createdMin = Number(process.env.SETTLEMENT_EXPIRY_CREATED_MINUTES);
  const pendingMin = Number(process.env.SETTLEMENT_EXPIRY_PENDING_MINUTES);
  const policy: ExpiryPolicy = {
    createdMaxAgeMs:
      (Number.isFinite(createdMin) && createdMin > 0 ? createdMin : DEFAULT_CREATED_MAX_AGE_MINUTES) * 60_000,
    pendingMaxAgeMs:
      (Number.isFinite(pendingMin) && pendingMin > 0 ? pendingMin : DEFAULT_PENDING_MAX_AGE_MINUTES) * 60_000,
  };
  return {
    createdMaxAgeMs: override?.createdMaxAgeMs ?? policy.createdMaxAgeMs,
    pendingMaxAgeMs: override?.pendingMaxAgeMs ?? policy.pendingMaxAgeMs,
  };
}

// ── sweeper ─────────────────────────────────────────────────────────────────
export interface ExpirySweeperDeps {
  findSettlementSweepCandidates: typeof realFindSettlementSweepCandidates;
  recordSettlementEvent: typeof realRecordSettlementEvent;
  applySettlementTransition: typeof realApplySettlementTransition;
}

const DEFAULT_DEPS: ExpirySweeperDeps = {
  findSettlementSweepCandidates: realFindSettlementSweepCandidates,
  recordSettlementEvent: realRecordSettlementEvent,
  applySettlementTransition: realApplySettlementTransition,
};

export interface SweepResult {
  ok: true;
  /** Non-terminal sessions inspected. */
  candidates: number;
  /** Sessions transitioned to `expired` by this run. */
  expired: number;
  /** Candidates not expired by this run: still fresh, anchor write failed, or the CAS transition did not land. */
  skipped: number;
  /** Candidates whose deterministic expiry event already existed, so no second anchor was written. Since c6
   *  2026-11-20 such a candidate still RE-ATTEMPTS its CAS (it is still non-terminal, so the earlier transition never
   *  landed) - this counts suppressed anchors, not skipped sessions. */
  duplicateSuppressed: number;
  /** Idempotency keys of the sessions expired by this run. */
  expiredKeys: string[];
}

/** Deterministic per-session expiry event id — a re-sweep collides on the
 *  append-only ledger's UNIQUE(provider, provider_event_id). */
function expiryEventId(idempotencyKey: string): string {
  return `sweeper_expiry:${idempotencyKey}`;
}

/**
 * Sweep stale non-terminal checkout sessions to `expired`. Deterministic +
 * idempotent — safe to run on any schedule.
 */
export async function sweepStaleSettlements(
  args?: { policy?: Partial<ExpiryPolicy>; nowMs?: number },
  depsOverride?: Partial<ExpirySweeperDeps>,
): Promise<SweepResult> {
  const deps: ExpirySweeperDeps = { ...DEFAULT_DEPS, ...depsOverride };
  const policy = resolveExpiryPolicy(args?.policy);
  const nowMs = args?.nowMs ?? Date.now();

  const candidates = await deps.findSettlementSweepCandidates();
  const expiredKeys: string[] = [];
  let skipped = 0;
  let duplicateSuppressed = 0;

  for (const c of candidates) {
    const state = c.settlementStatus as SettlementState;

    // Terminal-state safety: only created/pending may expire. (The query
    // already filters, but guard explicitly — never regress a terminal state.)
    if (state !== 'created' && state !== 'pending') { skipped++; continue; }
    if (!canTransition(state, 'expired')) { skipped++; continue; }

    // Age anchor: the last activity timestamp, else creation. An unparseable
    // anchor is treated as not-yet-stale (conservative — never expire blindly).
    const anchorRaw = c.lastReconciledAt ?? c.createdAt;
    const anchorMs = anchorRaw ? Date.parse(anchorRaw) : NaN;
    if (!Number.isFinite(anchorMs)) { skipped++; continue; }

    const threshold = state === 'created' ? policy.createdMaxAgeMs : policy.pendingMaxAgeMs;
    if (nowMs - anchorMs < threshold) { skipped++; continue; } // still fresh

    // Append-only event first — a deterministic id makes a re-sweep a duplicate.
    // A failed anchor write skips THIS candidate (retried next sweep) - never expire without the anchor, never abort
    // the whole sweep (c6 2026-11-20: it used to report not-duplicate and expire anyway).
    let recorded: { duplicate: boolean };
    try {
      recorded = await deps.recordSettlementEvent({
        provider: c.provider,
        providerEventId: expiryEventId(c.idempotencyKey),
        sessionReference: c.providerReference ?? '',
        checkoutIdempotencyKey: c.idempotencyKey,
        eventType: 'settlement.expired',
        normalizedStatus: 'expired',
        providerRawStatus: 'sweeper_expiry',
        payload: { source: 'settlement_expiry_sweeper', from: state },
      });
    } catch (err) {
      skipped++;
      logger.warn('settlement_expiry_anchor_failed', { message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    // The expiry anchor already exists, but this session is STILL a non-terminal stale candidate: the earlier sweep's
    // transition never landed (write failed, or its CAS lost to a webhook that moved created -> pending). Re-attempt
    // the CAS below instead of skipping it forever (c6 2026-11-20). The anchor is not re-written either way.
    if (recorded.duplicate) duplicateSuppressed++;

    // Persist the expiry transition. providerEventReference is intentionally
    // omitted so an existing provider_event_reference is PRESERVED.
    // CAS on the state the sweep decided from (class 2, 2026-11-12): a
    // `succeeded` webhook landing in between must never be regressed to expired.
    const applied = await deps.applySettlementTransition({
      idempotencyKey: c.idempotencyKey,
      settlementStatus: 'expired',
      providerRawStatus: 'sweeper_expiry',
      settledAt: null,
      fromStatus: c.settlementStatus,
    });
    if (!applied || applied.applied !== true) { skipped++; continue; } // a missing answer is never "expired" (7c)
    expiredKeys.push(c.idempotencyKey);
  }

  logger.info('settlement_expiry_sweep', {
    candidates: candidates.length, expired: expiredKeys.length,
    skipped, duplicateSuppressed, // no pricing
  });

  return {
    ok: true,
    candidates: candidates.length,
    expired: expiredKeys.length,
    skipped,
    duplicateSuppressed,
    expiredKeys,
  };
}
