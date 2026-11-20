import { ownedDbTable } from '../db/writeOwner';
/**
 * Credit Alert Service — Step 8
 *
 * Monitors organization credit balances and sends alerts at thresholds.
 * Deduplicates using the `credit_alert_log` table — each alert type
 * fires at most once per day per organization.
 *
 * Alert levels:
 *   - low_20pct   → balance < 20% of the organization's starting/purchased credits
 *   - low_10pct   → balance < 10% (critical — take action now)
 *   - depleted    → balance = 0 (autonomous system pauses)
 *   - auto_topup  → fired when auto top-up purchase is triggered (placeholder hook)
 *
 * Integration:
 *   Call `checkCreditAlerts(orgId)` from the autonomous scheduler or after
 *   each credit deduction. It is fast (reads one row, inserts at most once)
 *   and safe to call frequently.
 */

import { supabase } from '../db/supabaseClient';
import { CONFIRM_PHASES } from '../../shared/billing/creditPhaseVocabulary';
import { incrCounter } from './billing/billingMetrics';
import { logger } from './logger';

export type AlertType =
  // Absolute low-balance ladder (owner policy 2026-07-10): <100 / <50 / <20.
  | 'low_100' | 'low_50' | 'low_20'
  // Burn-velocity email (owner policy 2026-07-10): balance < 200 AND ≥ 100
  // credits consumed in the past 7 days — top-up nudge BEFORE disruption.
  | 'velocity_200'
  // Legacy types — retained for credit_alert_log history/dedup continuity.
  | 'low_20pct' | 'low_10pct'
  | 'depleted' | 'auto_topup'
  // Consumption-based warnings (approved policy) — deduped per billing cycle.
  | 'consumed_80' | 'consumed_90' | 'consumed_95' | 'forecast_insufficient_85'
  // 3-day runway warning (owner promise 2026-11-14; c6 2026-11-20). runway_3d_cleared is the RE-ARM marker: written
  // when a later evaluation finds the condition gone (e.g. after a top-up), so the next breach warns again.
  | 'runway_3d' | 'runway_3d_cleared';

const CONSUMED_ALERT_BY_THRESHOLD: Record<number, AlertType> = { 80: 'consumed_80', 90: 'consumed_90', 95: 'consumed_95' };

/** Which consumed_80/90/95 alerts have already fired for this org since `sinceIso` (cycle start). */
// CORRECT SENDING (2026-11-12): every dedup read in this file fails toward
// "already sent" (SUPPRESS) - an unread dedup check used to answer "not sent"
// and re-send the alert. Suppressing writes nothing, so the next run retries.
// The direction is deliberate (05): a missed-then-late alert is better than a
// duplicate - duplicates teach the recipient that credit alerts are noise, and
// then the one that matters is ignored. Do not "improve" this into a retry-send.
export async function getFiredConsumptionThresholds(orgId: string, sinceIso: string): Promise<number[]> {
  const { data, error } = await ownedDbTable('credit_alert_log')
    .select('alert_type')
    .eq('organization_id', orgId)
    .in('alert_type', ['consumed_80', 'consumed_90', 'consumed_95'])
    .gte('notified_at', sinceIso);
  if (error) {
    console.warn(`[creditAlert] dedup read failed for org ${orgId} - consumption alerts suppressed this run`, error.message);
    return [80, 90, 95];
  }
  const fired = new Set((data ?? []).map((r: any) => r.alert_type));
  return [80, 90, 95].filter((t) => fired.has(CONSUMED_ALERT_BY_THRESHOLD[t]));
}

/** Emit a consumption in-app warning + record it (dedup). */
export async function emitConsumptionAlert(orgId: string, threshold: number, consumedPct: number): Promise<void> {
  const type = CONSUMED_ALERT_BY_THRESHOLD[threshold];
  if (!type) return;
  // Record BEFORE sending; if the record cannot be written, do not send (an
  // unrecorded alert is re-sent next run).
  const { error: logErr } = await ownedDbTable('credit_alert_log').insert({ organization_id: orgId, alert_type: type, balance_at_alert: Math.round(consumedPct), notified_at: new Date().toISOString() });
  if (logErr) {
    console.warn(`[creditAlert] alert log write failed for org ${orgId} / ${type} - not sent`, logErr.message);
    return;
  }
  try {
    await ownedDbTable('notifications').insert({
      organization_id: orgId, type: 'credit_alert', category: type,
      message: `You have used ${threshold}% of this cycle's credits.`, read: false, created_at: new Date().toISOString(),
    });
  } catch { /* notifications table optional */ }
}

/** Whether the low-credit forecast email already went out this cycle. */
export async function wasForecastEmailSent(orgId: string, sinceIso: string): Promise<boolean> {
  const { data, error } = await ownedDbTable('credit_alert_log')
    .select('id').eq('organization_id', orgId).eq('alert_type', 'forecast_insufficient_85').gte('notified_at', sinceIso).limit(1).maybeSingle();
  if (error) {
    console.warn(`[creditAlert] forecast dedup read failed for org ${orgId} - email suppressed this run`, error.message);
    return true;
  }
  return !!data;
}

/** Record that the forecast email fired (per-cycle dedup). */
export async function recordForecastEmail(orgId: string, consumedPct: number): Promise<void> {
  // The caller records BEFORE sending: throw so an unrecorded email is not sent.
  const { error } = await ownedDbTable('credit_alert_log').insert({ organization_id: orgId, alert_type: 'forecast_insufficient_85', balance_at_alert: Math.round(consumedPct), notified_at: new Date().toISOString() });
  if (error) throw new Error(`[creditAlert] forecast email record failed for org ${orgId}: ${error.message}`);
}

export type CreditAlertResult = {
  balance: number;
  alerts_fired: AlertType[];
  alerts_suppressed: AlertType[]; // already sent today
};

// ── Configurable thresholds ───────────────────────────────────────────────────
/**
 * ABSOLUTE low-balance ladder (owner policy 2026-07-10):
 *   low_100  → balance < 100 credits  (early warning)
 *   low_50   → balance <  50 credits
 *   low_20   → balance <  20 credits  (last warning before depletion)
 *   depleted → balance <=  0
 * NO alert at 200 (explicitly removed). Thresholds are absolute credit
 * counts, not percentages of an allotment.
 *
 * Ordered MOST-SEVERE-FIRST: the loop below sends only the first breached
 * alert, so severity order guarantees a balance of e.g. 15 sends the
 * "below 20" warning — not a milder one. (The original mildest-first order
 * meant the severest alert could never fire: any low balance was swallowed
 * by the mildest notice + 24h dedup.)
 */
const THRESHOLDS: Array<{ type: AlertType; credits: number; breached: (balance: number, threshold: number) => boolean; message: string }> = [
  { type: 'depleted', credits: 0,   breached: (b, t) => b <= t, message: 'Credits depleted. Autonomous campaign system is paused.' },
  { type: 'low_20',   credits: 20,  breached: (b, t) => b < t,  message: 'Your credits are below 20 — top up now to keep content and campaigns running.' },
  { type: 'low_50',   credits: 50,  breached: (b, t) => b < t,  message: 'Your credits are below 50 — top up soon to avoid interruptions.' },
  { type: 'low_100',  credits: 100, breached: (b, t) => b < t,  message: 'Your credits are below 100 — consider topping up.' },
];

const DEDUP_HOURS = 24;

// ── Email escalation (owner policy 2026-07-10) ───────────────────────────────
/** Ladder levels that ALSO send an email to the company admin (not just in-app). */
const EMAIL_LEVELS: ReadonlySet<AlertType> = new Set(['low_20', 'depleted']);
/** Velocity email: balance below this … */
const VELOCITY_BALANCE_THRESHOLD = 200;
/** … while at least this many credits were consumed in the past 7 days. */
const VELOCITY_WEEKLY_CONSUMPTION = 100;
/** Velocity email fires at most once per week per org. */
const VELOCITY_DEDUP_HOURS = 7 * 24;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getBalance(orgId: string): Promise<number | null> {
  const { data, error } = await ownedDbTable('organization_credits')
    .select('free_balance, paid_balance, incentive_balance')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) {
    console.warn(`[creditAlert] balance read failed for org ${orgId} - no alerts this run`, error.message);
    return null;
  }
  if (!data) return null;
  const d = data as any;
  return (d.free_balance ?? 0) + (d.paid_balance ?? 0) + (d.incentive_balance ?? 0);
}

async function wasAlertRecentlySent(orgId: string, alertType: AlertType, dedupHours = DEDUP_HOURS): Promise<boolean> {
  const since = new Date(Date.now() - dedupHours * 3600_000).toISOString();
  const { data, error } = await ownedDbTable('credit_alert_log')
    .select('id')
    .eq('organization_id', orgId)
    .eq('alert_type', alertType)
    .gte('notified_at', since)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[creditAlert] dedup read failed for org ${orgId} / ${alertType} - treated as sent`, error.message);
    return true;
  }
  return !!data;
}

/** Company-admin email (oldest owner/admin role; same resolution as the forecast email). */
async function resolveAdminEmail(orgId: string): Promise<string | null> {
  const { data: roles, error: rolesErr } = await ownedDbTable('user_company_roles')
    .select('user_id, role, created_at')
    .eq('company_id', orgId)
    .eq('status', 'active');
  if (rolesErr) {
    console.warn(`[creditAlert] admin lookup failed for org ${orgId} - no email`, rolesErr.message);
    return null;
  }
  const list = (roles ?? []) as Array<{ user_id: string; role: string; created_at: string }>;
  if (list.length === 0) return null;
  const sorted = list.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const admin = sorted.find((r) => /owner|admin/i.test(String(r.role ?? ''))) ?? sorted[0];
  if (!admin?.user_id) return null;
  const { data: u, error: userErr } = await ownedDbTable('users')
    .select('email')
    .eq('id', admin.user_id)
    .maybeSingle();
  if (userErr) {
    console.warn(`[creditAlert] admin email read failed for org ${orgId} - no email`, userErr.message);
    return null;
  }
  return (u as { email?: string } | null)?.email ?? null;
}

/** Actual credits consumed in the past 7 days (settled amounts: confirm + confirm_partial rows). */
export async function getWeeklyConsumption(orgId: string): Promise<number> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  // Throw on a failed read: the velocity email (gated on this number) is then
  // not sent; the ladder email's caller substitutes 0 for its copy only.
  const { data, error } = await ownedDbTable('credit_transactions')
    .select('credits_delta, free_delta, paid_delta, incentive_delta')
    .eq('organization_id', orgId)
    .in('execution_phase', [...CONFIRM_PHASES])
    .gte('created_at', since);
  if (error) throw new Error(`[creditAlert] weekly consumption read failed for org ${orgId}: ${error.message}`);
  let total = 0;
  for (const row of (data ?? []) as Array<Record<string, number | null>>) {
    // Confirm rows record the ACTUAL settled cost; bucket deltas are the
    // authoritative amounts (credits_delta can be 0 on remainder-only settles).
    const byBuckets = Math.abs(row.free_delta ?? 0) + Math.abs(row.paid_delta ?? 0) + Math.abs(row.incentive_delta ?? 0);
    total += byBuckets > 0 ? byBuckets : Math.abs(row.credits_delta ?? 0);
  }
  return total;
}

/** Best-effort admin email for an alert level — never blocks or throws. */
async function sendAlertEmail(orgId: string, alertType: AlertType, balance: number, weeklyConsumed: number): Promise<void> {
  try {
    const recipient = await resolveAdminEmail(orgId);
    if (!recipient) return;
    const { sendCreditAlert } = await import('./emailService');
    const pool = weeklyConsumed + Math.max(0, balance);
    await sendCreditAlert(
      {
        recipientEmail: recipient,
        companyName: null,
        consumedPercent: pool > 0 ? Math.min(100, Math.round((weeklyConsumed / pool) * 100)) : 100,
        remainingCredits: Math.max(0, Math.round(balance)),
        projectedRequiredCredits: Math.round(weeklyConsumed),
        ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.omnivyra.com'}/company/billing`,
      },
      `credit_alert:${orgId}:${alertType}:${new Date().toISOString().slice(0, 10)}`,
    );
  } catch (err) {
    console.warn(`[creditAlert] email send failed for org ${orgId} / ${alertType}`, (err as Error)?.message);
  }
}

/** Record the alert (the dedup row). Returns false when it could not be written - the caller must then NOT send. */
/** Returns the row's notified_at when written (truthy), null when not - callers use it as the dedup handle. */
async function recordAlert(orgId: string, alertType: AlertType, balance: number): Promise<string | null> {
  const notifiedAt = new Date().toISOString();
  const { error } = await ownedDbTable('credit_alert_log').insert({
    organization_id: orgId,
    alert_type:      alertType,
    balance_at_alert: balance,
    notified_at:     notifiedAt,
  });
  if (error) {
    // b3 2026-11-20: "not sent" is fail-SAFE but must not be SILENT. An alertable event + counter; a CHECK violation
    // (23514) is its own event - the signature of a missing credit_alert_log alert_type widening migration.
    const code = (error as { code?: string }).code;
    incrCounter('credit_alert_dedup_write_failed_total');
    logger.error(code === '23514' ? 'credit_alert_suppressed_check_violation' : 'credit_alert_dedup_write_failed', {
      orgId, alertType, code: code ?? null, message: error.message,
    });
    return null;
  }
  return notifiedAt;
}

/** Send an in-app notification for a credit alert. */
async function sendAlert(orgId: string, alertType: AlertType, message: string): Promise<boolean> {
  // Returns whether the notice was written (7c 2026-11-20). The insert's { error } is READ: supabase reports a failed
  // write as { error } without throwing, so the old try/catch counted a failed notice as delivered.
  try {
    const { error } = await ownedDbTable('notifications').insert({
      organization_id: orgId,
      type:            'credit_alert',
      category:        alertType,
      message,
      read:            false,
      created_at:      new Date().toISOString(),
    });
    if (error) {
      console.warn(`[creditAlert] Notification insert failed for org ${orgId} / ${alertType}`, error.message);
      return false;
    }
    return true;
  } catch {
    // Non-fatal — notifications table may not exist yet
    console.warn(`[creditAlert] Notification insert failed for org ${orgId} / ${alertType}`);
    return false;
  }
}

// ── 3-day runway warning (owner promise 2026-11-14; c6 2026-11-20) ───────────
/**
 * "When a company's credits are forecast to run out within 3 days, ask them to buy credits" (in-app + email).
 *   runway_days = balance (free + paid + incentive) / (burn7 / 7), burn7 = the trailing 7-day SETTLED consumption
 *   (confirm + confirm_partial: getWeeklyConsumption, the shared vocabulary). Fires when balance > 0 AND burn7 > 0 AND
 *   runway_days <= RUNWAY_WARN_DAYS.
 * Dedup / re-arm: while the condition PERSISTS, at most one warning per RUNWAY_REPEAT_SUPPRESS_HOURS (a repeat
 * suppressor, NOT the forecast horizon - that is RUNWAY_WARN_DAYS); a later evaluation that finds the condition GONE (a top-up)
 * writes runway_3d_cleared, so the next breach warns again even inside the window.
 * A read failure (balance, consumption, the alert log) sends NOTHING and logs - never a false "you're fine", never a
 * duplicate.
 */
export const RUNWAY_WARN_DAYS = 3;
const RUNWAY_REPEAT_SUPPRESS_HOURS = 72;

export function runwayDays(balance: number, burn7: number): number | null {
  if (!(balance > 0) || !(burn7 > 0)) return null;
  return balance / (burn7 / 7);
}

/** The latest runway_3d / runway_3d_cleared row: 'armed' = may warn; null = unreadable (do not warn). */
async function runwayArmState(orgId: string): Promise<{ armed: boolean; lastWasWarning: boolean } | null> {
  const { data, error } = await ownedDbTable('credit_alert_log')
    .select('alert_type, notified_at')
    .eq('organization_id', orgId)
    .in('alert_type', ['runway_3d', 'runway_3d_cleared'])
    .order('notified_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn(`[creditAlert] runway state read failed for org ${orgId} - no runway warning this run`, error.message);
    return null;
  }
  const last = ((data ?? []) as Array<{ alert_type: string; notified_at: string }>)[0];
  if (!last) return { armed: true, lastWasWarning: false };
  if (last.alert_type === 'runway_3d_cleared') return { armed: true, lastWasWarning: false };
  const ageMs = Date.now() - Date.parse(last.notified_at);
  return { armed: Number.isFinite(ageMs) && ageMs >= RUNWAY_REPEAT_SUPPRESS_HOURS * 3600_000, lastWasWarning: true };
}

async function resolveCompanyName(orgId: string): Promise<string | null> {
  const { data, error } = await ownedDbTable('companies').select('name').eq('id', orgId).maybeSingle();
  if (error) return null;
  const name = (data as { name?: string | null } | null)?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Best-effort runway email to the company admin - never blocks or throws. */
async function sendRunwayEmail(orgId: string, days: number, balance: number): Promise<boolean> {
  try {
    const recipient = await resolveAdminEmail(orgId);
    if (!recipient) return false;
    const { sendCreditRunwayAlert } = await import('./emailService');
    await sendCreditRunwayAlert(
      {
        recipientEmail: recipient,
        companyName: await resolveCompanyName(orgId),
        runwayDays: Math.max(1, Math.ceil(days)),
        remainingCredits: Math.max(0, Math.round(balance)),
        ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.omnivyra.com'}/company/billing`,
      },
      `credit_runway:${orgId}:${new Date().toISOString().slice(0, 10)}`,
    );
    return true;
  } catch (err) {
    console.warn(`[creditAlert] runway email failed for org ${orgId}`, (err as Error)?.message);
    return false;
  }
}

/**
 * Evaluate the runway rung for one org. Returns 'warned' | 'cleared' | 'none' | 'unreadable' | 'unrecorded' | 'undelivered'.
 *   'unrecorded'  - breached and armed, but the dedup row could not be written (e.g. the alert_type migration is not
 *                   applied): NOT sent. Counted by the sweep so the inert state is a number, not a silent zero (7c F1).
 *   'undelivered' - BOTH channels failed after the row was written: the row is deleted so the next ordinary
 *                   evaluation warns again (7c F2: the 72h window equals the 3-day horizon, and this rung has no
 *                   successor). One attempt per evaluation - never a retry loop, never a duplicate when either
 *                   channel reached the recipient.
 * `balance` is passed in when the caller already read it (checkCreditAlerts); otherwise it is read here.
 */
export type RunwayOutcome = 'warned' | 'cleared' | 'none' | 'unreadable' | 'unrecorded' | 'undelivered';
export async function evaluateRunwayWarning(orgId: string, knownBalance?: number | null): Promise<RunwayOutcome> {
  const balance = knownBalance ?? await getBalance(orgId);
  if (balance === null || balance === undefined) return 'unreadable';
  let burn7: number;
  try {
    burn7 = await getWeeklyConsumption(orgId);
  } catch (err) {
    console.warn(`[creditAlert] runway consumption read failed for org ${orgId} - no runway warning this run`, (err as Error)?.message);
    return 'unreadable';
  }
  const days = runwayDays(balance, burn7);
  const breached = days !== null && days <= RUNWAY_WARN_DAYS;
  const state = await runwayArmState(orgId);
  if (state === null) return 'unreadable';
  if (!breached) {
    // Re-arm: the condition is gone since the last warning (top-up, lower burn) -> the next breach warns again.
    if (state.lastWasWarning && (await recordAlert(orgId, 'runway_3d_cleared', balance))) return 'cleared';
    return 'none';
  }
  if (!state.armed) return 'none';
  const notifiedAt = await recordAlert(orgId, 'runway_3d', balance);   // dedup row first: unrecorded = not sent
  if (!notifiedAt) return 'unrecorded';
  const shown = Math.max(1, Math.ceil(days as number));
  const inApp = await sendAlert(orgId, 'runway_3d',
    `At your current usage, your credits will run out in about ${shown} day${shown === 1 ? '' : 's'}. Top up to keep things running.`);
  const emailed = await sendRunwayEmail(orgId, days as number, balance);
  if (!inApp && !emailed) {
    // Nobody heard it: release the dedup row so the next evaluation warns (compensating delete, not a retry).
    const { error: delErr } = await ownedDbTable('credit_alert_log').delete()
      .eq('organization_id', orgId).eq('alert_type', 'runway_3d').eq('notified_at', notifiedAt);
    if (delErr) logger.error('credit_runway_undelivered_row_kept', { orgId, message: delErr.message });
    else logger.warn('credit_runway_undelivered', { orgId });
    return 'undelivered';
  }
  return 'warned';
}

/**
 * Daily sweep (ALWAYS_RUN_JOBS 'creditRunwaySweep'): evaluates every org that SETTLED consumption in the past 7 days,
 * so scheduled-only spenders (no interactive post-confirm path) are warned too. A failed org read aborts the sweep
 * loudly (never "nobody to warn").
 */
export async function runCreditRunwaySweep(): Promise<{ evaluated: number; warned: number; unrecorded: number; undelivered: number }> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { data, error } = await ownedDbTable('credit_transactions')
    .select('organization_id')
    .in('execution_phase', [...CONFIRM_PHASES])
    .gte('created_at', since)
    .limit(10000);
  if (error) throw new Error(`[creditAlert] runway sweep org read failed: ${error.message}`);
  const orgs = Array.from(new Set(((data ?? []) as Array<{ organization_id?: string | null }>)
    .map((r) => r.organization_id).filter((id): id is string => typeof id === 'string' && id.length > 0)));
  let warned = 0; let unrecorded = 0; let undelivered = 0;
  for (const orgId of orgs) {
    const o = await evaluateRunwayWarning(orgId);
    if (o === 'warned') warned += 1;
    else if (o === 'unrecorded') unrecorded += 1;
    else if (o === 'undelivered') undelivered += 1;
  }
  return { evaluated: orgs.length, warned, unrecorded, undelivered };
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Check credit balance for an org and fire alerts if thresholds are crossed.
 * Safe to call frequently — deduplicates within a 24-hour window.
 * `_referenceAllotment` is retained for caller compatibility but unused:
 * thresholds are absolute credit counts (owner policy 2026-07-10).
 */
export async function checkCreditAlerts(
  orgId: string,
  _referenceAllotment?: number,
): Promise<CreditAlertResult> {
  const balance = await getBalance(orgId);
  if (balance === null) {
    return { balance: 0, alerts_fired: [], alerts_suppressed: [] };
  }

  const fired:      AlertType[] = [];
  const suppressed: AlertType[] = [];

  for (const { type, credits, breached, message } of THRESHOLDS) {
    if (!breached(balance, credits)) continue;

    const alreadySent = await wasAlertRecentlySent(orgId, type);
    if (alreadySent) {
      // The most severe breached alert was already sent within the dedup
      // window — do NOT fall through and fire a MILDER one on top of it.
      suppressed.push(type);
      break;
    }

    if (!(await recordAlert(orgId, type, balance))) {
      // Unrecorded = would be re-sent next run: do not send now.
      suppressed.push(type);
      break;
    }
    await sendAlert(orgId, type, message);
    // Escalation levels (below 20 / depleted) ALSO email the company admin.
    if (EMAIL_LEVELS.has(type)) {
      await sendAlertEmail(orgId, type, balance, await getWeeklyConsumption(orgId).catch(() => 0));
    }
    fired.push(type);

    // Send only the most severe newly-breached alert (list is severity-ordered).
    break;
  }

  // ── Burn-velocity email (owner policy 2026-07-10) ─────────────────────────
  // Balance below 200 AND ≥ 100 credits consumed in the past 7 days → email
  // the admin so they can top up BEFORE the ladder alerts start firing.
  // Independent of the ladder (in-app) alerts; at most once per week per org.
  if (balance > 0 && balance < VELOCITY_BALANCE_THRESHOLD) {
    try {
      const alreadySent = await wasAlertRecentlySent(orgId, 'velocity_200', VELOCITY_DEDUP_HOURS);
      if (!alreadySent) {
        const weeklyConsumed = await getWeeklyConsumption(orgId);
        if (weeklyConsumed >= VELOCITY_WEEKLY_CONSUMPTION) {
          if (await recordAlert(orgId, 'velocity_200', balance)) { // dedup BEFORE send
            await sendAlertEmail(orgId, 'velocity_200', balance, weeklyConsumed);
            fired.push('velocity_200');
          }
        }
      }
    } catch (err) {
      console.warn(`[creditAlert] velocity check failed for org ${orgId}`, (err as Error)?.message);
    }
  }

  // ── 3-day runway warning (owner promise; independent of the ladder) ───────
  try {
    if ((await evaluateRunwayWarning(orgId, balance)) === 'warned') fired.push('runway_3d');
  } catch (err) {
    console.warn(`[creditAlert] runway check failed for org ${orgId}`, (err as Error)?.message);
  }

  return { balance, alerts_fired: fired, alerts_suppressed: suppressed };
}

/**
 * Fire an auto_topup alert (called by billing service when purchase is triggered).
 */
export async function recordAutoTopup(orgId: string, balance: number): Promise<void> {
  if (!(await recordAlert(orgId, 'auto_topup', balance))) return;
  await sendAlert(orgId, 'auto_topup', 'Credits auto-topped up successfully.');
}
