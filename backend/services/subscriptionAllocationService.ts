/**
 * Subscription monthly credit allocation engine.
 *
 * Grants each plan's monthly credits into the PLAN / monthly pool (the `free`
 * credit category — consumed first) — NEVER into the top-up pool (`paid`,
 * never-expiring). Idempotent: a deterministic idempotency key per
 * (org, plan, billing period) means re-running a cycle never double-grants
 * (createCredit no-ops on the UNIQUE idempotency_key).
 *
 * Scope: allocation only. No payment gateway, no checkout, no subscription
 * purchase flow. Assumes a valid subscription (plan assignment) already exists.
 */
import { createCredit } from './creditExecutionService';
import {
  resolveSubscriptionState,
  canReceiveSubscriptionCredits,
  type SubscriptionState,
} from './subscriptionStateResolver';
import { SYSTEM_USER_ID } from './auditActorService';
import { supabase } from '../db/supabaseClient';
import { logger } from './logger';

/** SECTION A — plan credit rules. Monthly grant per plan_key. */
export const PLAN_MONTHLY_CREDITS: Record<string, number> = {
  starter: 300,
  growth: 700,
  business: 1400,
};

export const ALLOCATION_REFERENCE_TYPE = 'subscription_allocation';

export function getMonthlyCreditsForPlan(planKey: string | null | undefined): number | null {
  if (!planKey) return null;
  return PLAN_MONTHLY_CREDITS[planKey.toLowerCase()] ?? null;
}

/**
 * Billing-period start (UTC, YYYY-MM-DD) for the cycle containing `now`,
 * anchored to `anchorDay` (clamped to 1..28 to avoid short-month drift).
 */
export function computePeriodStart(now: Date, anchorDay = 1): string {
  const clamped = Math.min(Math.max(1, Math.floor(anchorDay)), 28);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (now.getUTCDate() < clamped) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return new Date(Date.UTC(y, m, clamped)).toISOString().slice(0, 10);
}

/** Next allocation date = period start + 1 month. */
export function computeNextAllocationDate(periodStart: string): string {
  const d = new Date(`${periodStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildAllocationKey(orgId: string, planKey: string | null, periodStart: string): string {
  return `monthly_alloc:${orgId}:${planKey ?? 'none'}:${periodStart}`;
}

export type AllocationStatusKind =
  | 'allocated' | 'dry_run' | 'no_plan' | 'not_billable' | 'subscription_inactive'
  // Reads contract (B1b, e1): the state could not be READ. NOT terminal - nothing was written, so a later run in the
  // same period allocates (idempotency is per org/plan/period and only a granted row blocks it).
  | 'subscription_state_unreadable' | 'plan_unreadable';

class PlanUnreadableError extends Error {
  constructor(message: string) { super(message); this.name = 'PlanUnreadableError'; }
}

export interface AllocationResult {
  status: AllocationStatusKind;
  orgId: string;
  planKey: string | null;
  credits: number;
  periodStart: string;
  nextAllocationDate: string;
  idempotencyKey: string;
  referenceType: string;
  /** Canonical subscription state at allocation time (when evaluated). */
  subscriptionState?: SubscriptionState;
}

async function resolvePlanKey(orgId: string): Promise<string | null> {
  // B1b: a FAILED read is not "no plan" (a terminal skip for the whole month).
  const { data: assignment, error: assignmentErr } = await supabase
    .from('organization_plan_assignments')
    .select('plan_id')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (assignmentErr) throw new PlanUnreadableError(`organization_plan_assignments read failed: ${assignmentErr.message}`);
  const planId = (assignment as { plan_id?: string } | null)?.plan_id;
  if (!planId) return null;
  const { data: plan, error: planErr } = await supabase.from('pricing_plans').select('plan_key').eq('id', planId).maybeSingle();
  if (planErr) throw new PlanUnreadableError(`pricing_plans read failed: ${planErr.message}`);
  return (plan as { plan_key?: string } | null)?.plan_key ?? null;
}

/** B1b: alertable + countable - one ERROR log and operational event per org, keyed by the period's idempotency key. */
async function reportAllocationUnreadable(orgId: string, status: AllocationStatusKind, idempotencyKey: string | null, detail: string): Promise<void> {
  logger.error('subscription_allocation_state_unreadable', { orgId, status, idempotencyKey, detail });
  try {
    const { recordMonetizationOperationalEvent } = await import('./monetizationOpsService');
    await recordMonetizationOperationalEvent({
      eventName: 'monetization.subscription_allocation_unreadable',
      severity: 'ERROR',
      organizationId: orgId,
      alertKey: 'subscription_allocation_unreadable',
      metadata: { status, idempotency_key: idempotencyKey, detail },
    });
  } catch (err) {
    logger.error('subscription_allocation_unreadable_event_failed', { orgId, message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * SECTION B — allocate the current cycle's monthly credits into the plan pool,
 * idempotently. `dryRun` computes the result without granting (validation/preview).
 */
export async function allocateMonthlyCreditsForOrg(params: {
  orgId: string;
  planKey?: string | null;
  now?: Date;
  anchorDay?: number;
  performedBy?: string;
  dryRun?: boolean;
  /** Pre-resolved canonical state (testing / batch seam, mirrors `planKey?`). */
  subscriptionState?: SubscriptionState;
}): Promise<AllocationResult> {
  const { orgId } = params;
  const now = params.now ?? new Date();
  let planKey: string | null;
  try {
    // An explicit planKey (including null = "no plan") is honoured without a read; only an omitted one is resolved.
    planKey = params.planKey !== undefined ? params.planKey : await resolvePlanKey(orgId);
  } catch (err) {
    if (!(err instanceof PlanUnreadableError)) throw err;
    const periodStartU = computePeriodStart(now, params.anchorDay ?? 1);
    await reportAllocationUnreadable(orgId, 'plan_unreadable', null, err.message);
    return {
      status: 'plan_unreadable', orgId, planKey: null, credits: 0, periodStart: periodStartU,
      nextAllocationDate: computeNextAllocationDate(periodStartU), idempotencyKey: '', referenceType: ALLOCATION_REFERENCE_TYPE,
    };
  }
  const credits = getMonthlyCreditsForPlan(planKey);
  const periodStart = computePeriodStart(now, params.anchorDay ?? 1);
  const nextAllocationDate = computeNextAllocationDate(periodStart);
  const idempotencyKey = buildAllocationKey(orgId, planKey, periodStart);
  const base = { orgId, planKey, periodStart, nextAllocationDate, idempotencyKey, referenceType: ALLOCATION_REFERENCE_TYPE };

  if (!planKey) return { ...base, status: 'no_plan', credits: 0 };
  if (!credits) return { ...base, status: 'not_billable', credits: 0 };

  // Subscription-validity gate (canonical resolver). CANCELED / EXPIRED / PAST_DUE / GRACE /
  // paused cannot receive NEW subscription credits; only ACTIVE / TRIALING may. Legacy
  // admin-assigned plans (no billing_subscriptions row) resolve to ACTIVE, so existing
  // allocation is unchanged until the subscription lifecycle write-path lands.
  const subscriptionState = params.subscriptionState ?? (await resolveSubscriptionState(orgId, { db: supabase, now: () => now.getTime() }));
  if (subscriptionState === 'UNKNOWN') {
    await reportAllocationUnreadable(orgId, 'subscription_state_unreadable', idempotencyKey, 'subscription state could not be read');
    return { ...base, status: 'subscription_state_unreadable', credits: 0, subscriptionState };
  }
  if (!canReceiveSubscriptionCredits(subscriptionState)) {
    return { ...base, status: 'subscription_inactive', credits: 0, subscriptionState };
  }

  if (params.dryRun) return { ...base, status: 'dry_run', credits, subscriptionState };

  await createCredit({
    orgId,
    amount: credits,
    category: 'free', // PLAN / monthly pool — consumed first; NEVER 'paid' (top-up)
    referenceType: ALLOCATION_REFERENCE_TYPE,
    performedBy: params.performedBy ?? SYSTEM_USER_ID,
    idempotencyKey, // deterministic per (org, plan, period) → duplicate cycles are no-ops
    note: `Monthly ${planKey} allocation (${periodStart})`,
  });

  return { ...base, status: 'allocated', credits, subscriptionState };
}

export interface AllocationSweepSummary {
  processed: number;
  allocated: number;
  skipped: number;
  dryRun: boolean;
  results: AllocationResult[];
  /** B1b: orgs whose state could not be read this run (recoverable - a later run in the period allocates). */
  unreadable: number;
  /** B1b: orgs whose allocation threw (logged per org; recoverable likewise). */
  failed: number;
  /** B1b: the org list itself could not be read - nothing was attempted. */
  orgListUnreadable: boolean;
  /** B1b: true when any org was not decided - callers surface it as non-2xx WITHOUT failing the job (no DLQ). */
  incomplete: boolean;
}

/**
 * SECTION B (driver) — sweep active subscriptions and allocate the current
 * cycle. Idempotent end-to-end: safe to run daily; only the first run per cycle
 * grants. Pass `orgIds` to scope; omit to sweep all plan-assigned orgs.
 */
export async function runMonthlyAllocationSweep(params?: {
  orgIds?: string[];
  now?: Date;
  dryRun?: boolean;
}): Promise<AllocationSweepSummary> {
  const now = params?.now ?? new Date();
  const dryRun = params?.dryRun ?? false;

  let orgIds = params?.orgIds;
  if (!orgIds) {
    const { data, error } = await supabase.from('organization_plan_assignments').select('organization_id');
    if (error) {
      // B1b: never "no orgs this month". Do NOT throw - a failed job is DLQ'd and every later run in the window skips.
      logger.error('subscription_allocation_org_list_unreadable', { message: error.message });
      return { processed: 0, allocated: 0, skipped: 0, dryRun, results: [], unreadable: 0, failed: 0, orgListUnreadable: true, incomplete: true };
    }
    orgIds = Array.from(new Set((data ?? []).map((r: { organization_id?: string }) => r.organization_id).filter(Boolean) as string[]));
  }

  const results: AllocationResult[] = [];
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      results.push(await allocateMonthlyCreditsForOrg({ orgId, now, dryRun }));
    } catch (err) {
      // per-org failure must not abort the sweep - but it is counted and logged, never silent (B1b)
      failed += 1;
      logger.error('subscription_allocation_org_failed', { orgId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const allocated = results.filter((r) => r.status === 'allocated' || r.status === 'dry_run').length;
  const unreadable = results.filter((r) => r.status === 'subscription_state_unreadable' || r.status === 'plan_unreadable').length;
  return {
    processed: results.length, allocated, skipped: results.length - allocated, dryRun, results,
    unreadable, failed, orgListUnreadable: false, incomplete: unreadable > 0 || failed > 0,
  };
}

/** SECTION D/E — allocation history + cycle status for the Billing Center. */
export interface AllocationHistoryRow {
  date: string;
  credits: number;
  cycle: string;
  referenceId: string | null;
}

export interface AllocationStatus {
  planKey: string | null;
  monthlyCredits: number | null;
  lastAllocationDate: string | null;
  nextAllocationDate: string | null;
  creditsGrantedThisCycle: number;
  history: AllocationHistoryRow[];
}

export async function getAllocationStatus(orgId: string, now: Date = new Date()): Promise<AllocationStatus> {
  const planKey = await resolvePlanKey(orgId);
  const monthlyCredits = getMonthlyCreditsForPlan(planKey);
  const periodStart = computePeriodStart(now);

  const { data } = await supabase
    .from('credit_transactions')
    .select('credits_delta, created_at, idempotency_key, reference_id')
    .eq('organization_id', orgId)
    .eq('reference_type', ALLOCATION_REFERENCE_TYPE)
    .gt('credits_delta', 0)
    .order('created_at', { ascending: false })
    .limit(24);

  const rows = (data ?? []) as Array<{ credits_delta: number; created_at: string; idempotency_key: string | null; reference_id: string | null }>;
  const cycleOf = (key: string | null) => String(key ?? '').split(':').pop() ?? '';

  const creditsGrantedThisCycle = rows
    .filter((r) => cycleOf(r.idempotency_key) === periodStart)
    .reduce((s, r) => s + Math.max(0, Number(r.credits_delta ?? 0)), 0);

  return {
    planKey,
    monthlyCredits,
    lastAllocationDate: rows[0]?.created_at ?? null,
    nextAllocationDate: computeNextAllocationDate(periodStart),
    creditsGrantedThisCycle,
    history: rows.map((r) => ({
      date: r.created_at,
      credits: Math.max(0, Number(r.credits_delta ?? 0)),
      cycle: cycleOf(r.idempotency_key),
      referenceId: r.reference_id ?? null,
    })),
  };
}
