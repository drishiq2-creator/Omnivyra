/**
 * subscriptionStateResolver.ts
 *
 * THE single canonical resolver for subscription state (Phase: subscription-state
 * rehabilitation). Eliminates the split-brain between `organization_plan_assignments`
 * (stateless plan tier) and `billing_subscriptions` (lifecycle status) by deriving ONE
 * authoritative state from `billing_subscriptions`, with a legacy fallback so existing
 * admin-assigned plans keep working until the subscription lifecycle write-path lands.
 *
 * Returns exactly one of: ACTIVE | TRIALING | GRACE | PAST_DUE | EXPIRED | CANCELED.
 *
 * Pure derivation is hermetically testable (`resolveSubscriptionStateFrom`); the async
 * `resolveSubscriptionState` loads the row + plan-assignment presence.
 *
 * Scope guard: this file ONLY resolves state and exposes entitlement predicates. It does NOT
 * lock top-up credits, change credit expiry, or send notifications.
 */

export type SubscriptionState =
  | 'ACTIVE'
  | 'TRIALING'
  | 'GRACE'
  | 'PAST_DUE'
  | 'EXPIRED'
  | 'CANCELED'
  // Reads contract (B1, e9): the subscription could not be READ. Never derived from data - only a failed read yields it.
  // Every entitlement predicate refuses it (allow-lists), and it never expires credits.
  | 'UNKNOWN';

/** Reads contract (B1): the subscription state could not be READ. Typed and retryable. */
export class SubscriptionStateUnreadableError extends Error {
  readonly code = 'SUBSCRIPTION_STATE_UNREADABLE' as const;
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionStateUnreadableError';
  }
}

/** Days after `current_period_end` during which a lapsed sub is GRACE/PAST_DUE, not yet EXPIRED. */
export const GRACE_DAYS = 3;

export interface BillingSubscriptionRow {
  status: string | null;                 // billing_subscriptions.status
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean | null;
}

export interface SubscriptionStateContext {
  subscription: BillingSubscriptionRow | null; // latest billing_subscriptions row, or null
  hasPlanAssignment: boolean;                  // organization_plan_assignments row exists
  nowMs: number;
  graceDays?: number;
}

/** PURE: derive the single canonical state. */
export function resolveSubscriptionStateFrom(ctx: SubscriptionStateContext): SubscriptionState {
  const sub = ctx.subscription;

  // No lifecycle row yet. Today billing_subscriptions is unpopulated, so an admin-assigned plan
  // is the only signal — treat it as a perpetual (legacy) entitlement to avoid regressing
  // existing allocation. Once the lifecycle write-path exists, real rows take over.
  if (!sub) {
    return ctx.hasPlanAssignment ? 'ACTIVE' : 'EXPIRED';
  }

  const now = ctx.nowMs;
  const graceMs = (ctx.graceDays ?? GRACE_DAYS) * 86_400_000;
  const periodEnd = sub.current_period_end ? Date.parse(sub.current_period_end) : NaN;
  const trialEnd = sub.trial_ends_at ? Date.parse(sub.trial_ends_at) : NaN;
  const withinPeriod = Number.isFinite(periodEnd) && now < periodEnd;
  const withinGrace = Number.isFinite(periodEnd) && now < periodEnd + graceMs;
  const status = String(sub.status ?? '').toLowerCase();

  switch (status) {
    case 'canceled':
    case 'cancelled':
      return 'CANCELED';
    case 'expired':
      return 'EXPIRED';
    case 'paused':
      // Not in the 6-state set and not entitled → treated as EXPIRED (no new credits).
      return 'EXPIRED';
    case 'trialing': {
      const trialActive = Number.isFinite(trialEnd) ? now < trialEnd : withinPeriod;
      return trialActive ? 'TRIALING' : 'EXPIRED';
    }
    case 'past_due':
      return withinGrace ? 'PAST_DUE' : 'EXPIRED';
    case 'active':
      if (sub.cancel_at_period_end && !withinPeriod) return 'CANCELED'; // scheduled cancel took effect
      if (withinPeriod) return 'ACTIVE';
      if (withinGrace) return 'GRACE';
      return 'EXPIRED';
    default:
      // Unknown/empty status → derive from the period; fall back to legacy entitlement.
      if (withinPeriod) return 'ACTIVE';
      if (withinGrace) return 'GRACE';
      return ctx.hasPlanAssignment ? 'ACTIVE' : 'EXPIRED';
  }
}

/** New SUBSCRIPTION credits may be granted only while genuinely current. */
export function canReceiveSubscriptionCredits(state: SubscriptionState): boolean {
  return state === 'ACTIVE' || state === 'TRIALING';
}

/** General access entitlement (e.g. future top-up gate) — includes grace. Not used for allocation. */
export function isEntitled(state: SubscriptionState): boolean {
  return state === 'ACTIVE' || state === 'TRIALING' || state === 'GRACE';
}

/**
 * Top-up usability: already-purchased top-up credits stay usable through every non-terminal
 * state (ACTIVE / TRIALING / GRACE / PAST_DUE) and are LOCKED only when the subscription is
 * terminally gone (EXPIRED / CANCELED). PAST_DUE is intentionally usable — the customer already
 * paid for those credits and is in a payment-retry grace window. Renewal → ACTIVE auto-restores.
 */
export function isTopupUsable(state: SubscriptionState): boolean {
  // An ALLOW-list (B1): a deny-list (`!== EXPIRED && !== CANCELED`) would have made UNKNOWN usable.
  return state === 'ACTIVE' || state === 'TRIALING' || state === 'GRACE' || state === 'PAST_DUE';
}

export interface TopupEntitlement {
  usable: boolean;
  state: SubscriptionState | 'NO_SUBSCRIPTION';
}

/**
 * Resolve top-up usability for an org. NON-REGRESSIVE: an org whose billing_subscriptions READ finds no row (never
 * subscribed / legacy) is NOT gated — top-up stays usable. Only an org with an actual terminated subscription
 * (EXPIRED/CANCELED) is locked. FAIL CLOSED (B1, e9/e1; previously failed open): a FAILED read throws
 * SubscriptionStateUnreadableError - an EXPIRED/CANCELED org must not regain top-up on a transient error. Callers
 * refuse retryably (503); a paid balance is never shown as "insufficient" (e1).
 */
export async function resolveTopupEntitlement(organizationId: string, deps: ResolverDeps): Promise<TopupEntitlement> {
  const nowMs = deps.now ? deps.now() : Date.now();
  let r: { data?: unknown[] | null; error?: { message?: string } | null } | undefined;
  try {
    r = await deps.db
      .from('billing_subscriptions')
      .select('status, current_period_end, trial_ends_at, cancel_at_period_end')
      .eq('organization_id', organizationId)
      .order('current_period_end', { ascending: false })
      .limit(1);
  } catch (err) {
    throw new SubscriptionStateUnreadableError(`billing_subscriptions read failed for ${organizationId}: ${(err as Error)?.message ?? 'error'}`);
  }
  if (r?.error) throw new SubscriptionStateUnreadableError(`billing_subscriptions read failed for ${organizationId}: ${r.error.message ?? 'error'}`);
  const row = ((r?.data ?? [])[0] ?? null) as BillingSubscriptionRow | null;
  if (!row) return { usable: true, state: 'NO_SUBSCRIPTION' };
  const state = resolveSubscriptionStateFrom({ subscription: row, hasPlanAssignment: false, nowMs, graceDays: deps.graceDays });
  return { usable: isTopupUsable(state), state };
}

// ── Async resolver (injectable db) ───────────────────────────────────────────
export interface ResolverDeps {
  db: { from: (table: string) => any };
  now?: () => number;
  graceDays?: number;
}

/**
 * Resolve the canonical state for an org. Loads the latest billing_subscriptions row (by
 * current_period_end) + plan-assignment presence. Never throws into a caller. FAIL CLOSED (B1, e9; previously a
 * failed read fell back to "plan assignment -> ACTIVE", which granted monthly credits to a canceled org): if EITHER
 * read fails the state is 'UNKNOWN', which no entitlement predicate accepts (allocation -> subscription_inactive;
 * the next run re-checks).
 */
export async function resolveSubscriptionState(organizationId: string, deps: ResolverDeps): Promise<SubscriptionState> {
  const nowMs = deps.now ? deps.now() : Date.now();
  try {
    const subRes = await deps.db
      .from('billing_subscriptions')
      .select('status, current_period_end, trial_ends_at, cancel_at_period_end')
      .eq('organization_id', organizationId)
      .order('current_period_end', { ascending: false })
      .limit(1);
    if (subRes?.error) return 'UNKNOWN';
    const subscription = (subRes?.data ?? [])[0] ?? null;
    const planRes = await deps.db.from('organization_plan_assignments').select('organization_id').eq('organization_id', organizationId).maybeSingle();
    if (planRes?.error) return 'UNKNOWN';
    const hasPlanAssignment = Boolean(planRes?.data);
    return resolveSubscriptionStateFrom({ subscription, hasPlanAssignment, nowMs, graceDays: deps.graceDays });
  } catch {
    return 'UNKNOWN';
  }
}
