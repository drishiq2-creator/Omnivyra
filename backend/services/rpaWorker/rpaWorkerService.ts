import { enqueueRpaTask, startRpaWorker } from './rpaTaskQueue';
import { buildScript } from './rpaPlatformScripts';
import { runRpaScript } from './rpaPlaywrightRunner';
import { rpaEnvReady, assertRpaEnvReady, isProbeFailure, getRpaEnvProbeDiagnostics } from './rpaEnv';
import { admitRpaTask, observeAllActiveOrgs } from './rpaQueueState';
import {
  acceptRpaTask,
  finalizeRpaClaim,
  flushRpaRetryQueueRoundRobin,
  countDueRpaRetries,
  rpaWorkerIdentity,
  rpaRunContextForClaim,
  releaseRpaClaimNotAttempted,
  RPA_CLAIM_LOST,
} from './rpaRetryQueue';
import { isBrowserWorkerRuntime, BROWSER_RUNTIME_REFUSED } from '../browserRuntime/browserRuntimeEnv';
import { SYNTHETIC_PAGE_CHECK_PLATFORM, syntheticPageCheckHandler } from './syntheticPageCheckHandler';
import { withHeavyJobSlot } from '../../queue/bullmqClient';
import {
  resolveCommunityAiPlatformPolicy,
  decideCommunityAiAutomatedTick,
  decideCommunityAiExecutionPolicy,
  type CommunityAiPolicyBlockReason,
} from '../communityAiPlatformPolicyService';
import { ownedDbTable } from '../../db/writeOwner';
import { checkCommunityActionContactGovernance } from '../communityAiContactGovernanceGate';

export type RpaTask = {
  tenant_id: string;
  organization_id: string;
  platform: string;
  action_type: 'reply' | 'like' | 'share' | 'follow' | 'schedule';
  target_url: string;
  text?: string | null;
  action_id: string;
};

export type RpaResult = {
  success: boolean;
  /** Platform-native id surfaced by the runner when the script extracted one. */
  platform_id?: string;
  /** Local filesystem path of the audit screenshot (legacy / fallback). */
  screenshot_path?: string;
  /** Durable public URL of the screenshot stored in the rpa-artifacts bucket. */
  screenshot_url?: string;
  error?: string;
  /** Round 26: a refusal that can never succeed on retry (the retry row is retired, not re-attempted). */
  terminal?: boolean;
  /**
   * The browser may already have performed the action (a click / submit was
   * issued) but success could not be confirmed: lost response, crash or
   * post-condition miss after the interaction. NOT a definite failure and
   * never auto-retried (a retry could double-post or un-like).
   */
  outcome_unknown?: boolean;
  /**
   * Phase C: nothing was executed (no browser touched the platform). Safe to
   * queue or retry. Set on every pre-side-effect refusal of executeRpaTask.
   */
  not_attempted?: boolean;
  /** Phase C: a web process durably queued the task for the browser worker. */
  queued_for_worker?: boolean;
  /** Phase C: the action already has a queue row (queued, running, done or parked): not run again. */
  duplicate?: boolean;
  /**
   * Review S-1: the claim's lease check (renew) failed before the handler ran;
   * nothing was executed. Always paired with not_attempted.
   */
  claim_lost?: boolean;
};

/**
 * Per-run context for one claimed queue row. `renewClaim` re-checks the claim
 * (token still held, lease unexpired) and extends the lease; false = do NOT
 * run. Absent for runs that hold no claim (tests, diagnostics).
 */
export type RpaRunContext = { renewClaim?: () => Promise<boolean> };

type RpaHandler = (task: RpaTask, ctx?: RpaRunContext) => Promise<RpaResult>;

/** Result of a run refused by the lease check: nothing executed. */
const claimLostResult = (): RpaResult => ({ success: false, not_attempted: true, claim_lost: true, error: RPA_CLAIM_LOST });

const normalizePlatform = (platform: string) => platform.trim().toLowerCase();

/**
 * Worker-startup gate: call this from the long-running RPA worker's main
 * loop so a misconfigured environment fails loudly rather than silently
 * draining the queue with RPA_ENV_NOT_READY failures.
 */
export { assertRpaEnvReady };

/**
 * Scheduler entry points. The cron worker calls these on its own cadence
 * to observe state and drain deferred retries. Both are per-org aware:
 *
 *   observeBackpressure — enumerates organizations with recent RPA
 *     activity, computes per-org state, upserts rpa_queue_state.
 *
 *   flushRetries — round-robin over orgs with due retries; each org gets
 *     at most `limit_per_org` sweep slots. No single tenant can
 *     monopolise the worker's attention.
 */
export const rpaSchedulerHooks = {
  observeBackpressure: observeAllActiveOrgs,
  flushRetries: async (opts?: { limit_per_org?: number; max_orgs?: number }): Promise<RpaFlushTickResult> => {
    // Order (24C): every step below is cheaper than the next and each one
    // short-circuits the rest.
    //   1. due-row count (one head-only DB count) — an empty queue never
    //      reads policy and never launches Chromium;
    //   2. platform kill switch — disabled execution never launches Chromium
    //      and never touches a row (fail-closed on an unreadable policy);
    //   3. env readiness probe (Chromium launch, memoized; failures back off
    //      exponentially in rpaEnv and log once per real probe, not per tick);
    //   4. per-row gate (kill switch + approval of record) before any handler.
    const idle = (extra: Partial<RpaFlushTickResult>): RpaFlushTickResult => ({
      orgs_visited: 0, claimed: 0, succeeded: 0, failed: 0, unknown: 0, claim_lost: 0, errors: 0, remaining: 0,
      due: 0, skipped_empty: 0, skipped_runtime: 0, skipped_policy: 0, skipped_env: 0, env_failure_streak: 0, env_next_probe_in_s: 0,
      parked_expired: 0,
      ...extra,
    });
    const dueCheck = await countDueRpaRetries();
    if (dueCheck.error) {
      console.warn(`[rpaRetryQueueFlush] due-count read failed: ${String(dueCheck.error).split(/\r?\n/)[0].slice(0, 200)}`);
      return idle({ errors: 1 });
    }
    if (dueCheck.due === 0) return idle({ skipped_empty: 1 });

    // Phase C: only the designated browser worker claims and executes queue
    // rows. Anywhere else (Vercel, web, dev) the tick stops here: no policy
    // read, no Chromium probe, no row claimed.
    if (!isBrowserWorkerRuntime()) return idle({ due: dueCheck.due, skipped_runtime: 1 });

    // Platform kill switch (round 28, review P-3): fail-closed tick gate. A
    // missing policy row, an unreadable policy or execution_enabled=false
    // stops the flush with no launch and no row touched. Runs AFTER the
    // due-count, so an empty queue still never reads policy.
    const tick = decideCommunityAiAutomatedTick(await resolveCommunityAiPlatformPolicy(), 'rpa_retry');
    if (tick.allowed === false) {
      console.warn(`[rpaRetryQueueFlush] skipped — platform policy refused (${tick.reason_code})`);
      return idle({ due: dueCheck.due, skipped_policy: 1 });
    }

    // Single env readiness check per tick. If Playwright/Chromium is
    // unavailable, skip the whole tick cleanly instead of iterating every
    // due row (each would otherwise fail downstream identically). The
    // probe itself logs one line per real (backed-off) probe failure.
    const ready = await rpaEnvReady();
    if (isProbeFailure(ready)) {
      const diag = typeof getRpaEnvProbeDiagnostics === 'function' ? getRpaEnvProbeDiagnostics() : null;
      return idle({
        due: dueCheck.due,
        skipped_env: 1,
        env_failure_streak: diag?.failure_streak ?? 0,
        env_next_probe_in_s: diag?.next_probe_in_s ?? 0,
      });
    }
    const flushed = await flushRpaRetryQueueRoundRobin({
      handler: async (task, ctx) => {
        // Retry path bypasses the admission gate to avoid infinite
        // deferral during partial outages. Env readiness is still
        // enforced downstream by the playwright runner. It does NOT
        // bypass the kill switch or approval: both are re-checked against
        // the action of record before anything is re-executed.
        const gate = await checkRpaRetryAuthorised(task);
        if (gate.ok === false) {
          console.warn(`[rpaRetryQueueFlush] refused action=${task.action_id} reason=${gate.reason}`);
          return { success: false, error: gate.reason, ...(gate.terminal ? { terminal: true } : {}) };
        }
        const h = handlers[normalizePlatform(task.platform)];
        if (!h) return { success: false, error: 'RPA_PLATFORM_NOT_SUPPORTED' };
        return h(task, ctx);
      },
      limitPerOrg: opts?.limit_per_org,
      maxOrgs: opts?.max_orgs,
    });
    return {
      ...idle({ due: dueCheck.due }),
      orgs_visited: flushed.orgs_visited,
      claimed: flushed.claimed,
      succeeded: flushed.succeeded,
      failed: flushed.failed,
      unknown: flushed.unknown ?? 0,
      claim_lost: flushed.claim_lost ?? 0,
      errors: flushed.errors,
      remaining: flushed.remaining,
      parked_expired: flushed.parked_expired ?? 0,
    };
  },
};

/** Counters returned by one `flushRetries` tick (all safe numbers). */
export type RpaFlushTickResult = {
  orgs_visited: number;
  claimed: number;
  succeeded: number;
  failed: number;
  /** Executed, outcome unknown — row parked for reconciliation, not failed. */
  unknown: number;
  /** Claimed but not run: the lease check before the handler failed (review S-1). */
  claim_lost: number;
  errors: number;
  remaining: number;
  /** Due rows seen by the pre-check. */
  due: number;
  /** 1 when the tick stopped at the empty-queue pre-check (no probe, no policy read). */
  skipped_empty: number;
  /** 1 when this process is not the browser worker (no policy read, no probe, no claim). */
  skipped_runtime: number;
  /** Expired claims parked as outcome-unknown this tick (never re-run). */
  parked_expired: number;
  /** 1 when the kill switch stopped the tick (no probe). */
  skipped_policy: number;
  /** 1 when the env probe (cached / backed off) stopped the tick. */
  skipped_env: number;
  env_failure_streak: number;
  env_next_probe_in_s: number;
};

/**
 * Action statuses from which a deferred RPA retry may re-execute. On this
 * code line a deferred RPA run is persisted as `failed`; `approved` covers a
 * row that was approved but never ran. Anything else (executed,
 * sent_unverified, skipped, blocked, pending, rejected, deleted, executing)
 * is not re-run.
 */
const RPA_RETRY_REEXECUTABLE_STATUSES = new Set(['approved', 'failed']);

export type RpaRetryGate = { ok: true } | { ok: false; reason: string; terminal?: boolean };

/**
 * Gate for re-executing a retry-queue row (port of the eec0117d intent:
 * the retry flush must honour the platform kill switch and approval of
 * record instead of calling the Playwright handler blindly).
 *
 *   1. platform policy via the fail-closed evaluator (round 28: missing row,
 *      unreadable or execution_enabled=false all refuse; fail-closed on
 *      unreadable policy);
 *   2. the community_ai_actions row of record exists in the SAME
 *      organization as the retry row;
 *   3. its status is re-executable;
 *   4. it carries a recorded approval (`approved_at`). This also satisfies
 *      the executor's require_human_approval / high-risk gates, which both
 *      key on approved_at.
 *   5. (round 26, review S-3 / C-5) CONTACT GOVERNANCE: the retry re-runs the
 *      Playwright handler directly, bypassing runExecution's gate, so the same
 *      gate is asked here on the row of record (its own tenant, platform,
 *      action type and target; the author of the comment replied to is
 *      resolved by the gate). Suppressed or unidentifiable → TERMINAL refusal
 *      (retired, never re-attempted); governance unreadable → refused this
 *      round, retried later (nothing was sent).
 *      The platform kill switch (step 1, review P-3) is untouched here.
 *
 * Any read error refuses.
 */
export async function checkRpaRetryAuthorised(task: RpaTask): Promise<RpaRetryGate> {
  // Round 28: ONE gate, in order — policy (kill switch) → action of record →
  // re-executable status → approval of record → contact governance. The
  // policy is resolved once and decided twice: before the row read (no row is
  // read when automation is off) and against the row's approved_at.
  const resolution = await resolveCommunityAiPlatformPolicy();
  const preRead = decideCommunityAiAutomatedTick(resolution, 'rpa_retry');
  if (preRead.allowed === false) return { ok: false, reason: rpaRetryPolicyReason(preRead.reason_code) };
  if (!task?.action_id || !task?.organization_id) {
    return { ok: false, reason: 'RPA_RETRY_ACTION_UNKNOWN' };
  }
  let row: Record<string, any> | null = null;
  try {
    const { data, error } = await ownedDbTable('community_ai_actions')
      .select('id, organization_id, status, approved_at, platform, action_type, target_id')
      .eq('id', task.action_id)
      .eq('organization_id', task.organization_id)
      .maybeSingle();
    if (error) return { ok: false, reason: 'RPA_RETRY_ACTION_UNREADABLE' };
    row = (data as Record<string, any> | null) ?? null;
  } catch {
    return { ok: false, reason: 'RPA_RETRY_ACTION_UNREADABLE' };
  }
  if (!row || row.organization_id !== task.organization_id) {
    return { ok: false, reason: 'RPA_RETRY_ACTION_NOT_FOUND' };
  }
  if (!RPA_RETRY_REEXECUTABLE_STATUSES.has(String(row.status ?? ''))) {
    return { ok: false, reason: 'RPA_RETRY_ACTION_NOT_RETRYABLE' };
  }
  const decision = decideCommunityAiExecutionPolicy(resolution, {
    initiator: 'rpa_retry',
    approved_at: (row.approved_at as string | null) ?? null,
  });
  if (decision.allowed === false) return { ok: false, reason: rpaRetryPolicyReason(decision.reason_code) };
  const contactGate = await checkCommunityActionContactGovernance({
    id: String(row.id),
    organization_id: task.organization_id,
    platform: (row.platform as string | null) ?? task.platform,
    action_type: (row.action_type as string | null) ?? task.action_type,
    target_id: (row.target_id as string | null) ?? task.target_url,
    metadata: null,
  });
  if (contactGate.allowed === false) {
    if (contactGate.code === 'CONTACT_SUPPRESSED') return { ok: false, reason: 'RPA_RETRY_CONTACT_SUPPRESSED', terminal: true };
    if (contactGate.code === 'CONTACT_IDENTITY_UNRESOLVED') return { ok: false, reason: 'RPA_RETRY_CONTACT_IDENTITY_UNRESOLVED', terminal: true };
    return { ok: false, reason: 'RPA_RETRY_CONTACT_GOVERNANCE_UNAVAILABLE' };
  }
  return { ok: true };
}

/** Keep the retry refusal strings existing tests and dashboards read. */
const rpaRetryPolicyReason = (code: CommunityAiPolicyBlockReason): string => {
  switch (code) {
    case 'execution_disabled': return 'RPA_RETRY_EXECUTION_DISABLED';
    case 'approval_required': return 'RPA_RETRY_NOT_APPROVED';
    case 'policy_missing_fail_closed': return 'RPA_RETRY_POLICY_MISSING';
    case 'policy_unreadable_fail_closed': return 'RPA_RETRY_POLICY_UNREADABLE';
    default: return `RPA_RETRY_${String(code).toUpperCase()}`;
  }
};

/**
 * Unified Playwright-backed handler for every platform. Script selection
 * is delegated to `buildScript(task)`; a platform that has no script for
 * the requested action is surfaced as a structured failure.
 */
const playwrightHandler: RpaHandler = async (task, ctx) => {
  const script = buildScript(task);
  if ('error' in script) {
    return { success: false, error: script.error };
  }
  // Chromium execution counts toward the shared in-process heavy-job budget
  // (HEAVY_JOB_CONCURRENCY) alongside ai-heavy + creator-render. buildScript()
  // is cheap and intentionally left outside the slot. Single chokepoint:
  // covers BOTH the scheduler retry path and the executeRpaTask path.
  return withHeavyJobSlot(async () => {
    // Review S-1: the slot wait can be long; re-check (and extend) the claim
    // immediately before the browser is touched. Lost -> nothing runs.
    if (ctx?.renewClaim && !(await ctx.renewClaim())) return claimLostResult();
    return runRpaScript(task, script);
  });
};

const handlers: Record<string, RpaHandler> = {
  facebook:  playwrightHandler,
  instagram: playwrightHandler,
  twitter:   playwrightHandler,
  reddit:    playwrightHandler,
  linkedin:  playwrightHandler,
  // Phase C: synthetic pipeline check (loopback / data: targets only, off
  // unless RPA_SYNTHETIC_HANDLER_ENABLED=true). Not a platform.
  [SYNTHETIC_PAGE_CHECK_PLATFORM]: syntheticPageCheckHandler,
};

/** Registered handler platforms (read-only view for tests and diagnostics). */
export const registeredRpaPlatforms = (): string[] => Object.keys(handlers).sort();

const validateTask = (task: RpaTask) => {
  if (!task?.tenant_id) return { ok: false, error: 'TENANT_ID_REQUIRED' };
  if (!task?.organization_id) return { ok: false, error: 'ORGANIZATION_ID_REQUIRED' };
  if (!task?.platform) return { ok: false, error: 'PLATFORM_REQUIRED' };
  if (!task?.action_type) return { ok: false, error: 'ACTION_TYPE_REQUIRED' };
  if (!task?.target_url) return { ok: false, error: 'TARGET_URL_REQUIRED' };
  if (!task?.action_id) return { ok: false, error: 'ACTION_ID_REQUIRED' };
  if (task.action_type !== 'reply' && task.action_type !== 'like') {
    return { ok: false, error: 'ACTION_TYPE_NOT_SUPPORTED' };
  }
  return { ok: true };
};

/**
 * Accept and (on the browser worker only) execute one RPA task.
 *
 * Phase C:
 *   - every accepted task gets a durable rpa_retry_queue row BEFORE anything
 *     runs; one row per action (a duplicate accept is a no-op and nothing runs);
 *   - NOT the browser worker (Vercel / web / dev): no probe, no RPA launch. The task
 *     is queued durably for the worker and reported as not attempted;
 *   - on the worker the row is born CLAIMED by this process; the outcome is
 *     written through the token-matched finaliser. A crash or a lease that
 *     expires leaves the claim to be parked as outcome-unknown (never re-run).
 *     The in-process task queue only serialises execution; it is no longer the
 *     only record of the task.
 */
export const executeRpaTask = async (task: RpaTask): Promise<RpaResult> => {
  const validation = validateTask(task);
  if (!validation.ok) {
    return { success: false, not_attempted: true, error: validation.error };
  }

  const handler = handlers[normalizePlatform(task.platform)];
  if (!handler) {
    return { success: false, not_attempted: true, error: 'RPA_PLATFORM_NOT_SUPPORTED' };
  }

  if (!isBrowserWorkerRuntime()) {
    const queued = await acceptRpaTask(task);
    if (queued.ok === false) {
      return { success: false, not_attempted: true, error: `RPA_QUEUE_FAILED:${queued.error}` };
    }
    if (!queued.accepted) {
      return { success: false, not_attempted: true, duplicate: true, error: 'RPA_TASK_ALREADY_QUEUED' };
    }
    return {
      success: false,
      not_attempted: true,
      queued_for_worker: true,
      error: `${BROWSER_RUNTIME_REFUSED}:QUEUED_FOR_WORKER`,
    };
  }

  // Browser worker: durable record first, born claimed by this process.
  const accepted = await acceptRpaTask(task, { claimFor: rpaWorkerIdentity() });
  if (accepted.ok === false) {
    return { success: false, not_attempted: true, error: `RPA_QUEUE_FAILED:${accepted.error}` };
  }
  if (!accepted.accepted || !accepted.claim) {
    return { success: false, not_attempted: true, duplicate: true, error: 'RPA_TASK_ALREADY_QUEUED' };
  }
  const claim = accepted.claim;
  const release = async (outcome: 'succeeded' | 'failed' | 'unknown', opts?: Parameters<typeof finalizeRpaClaim>[2]) => {
    const r = await finalizeRpaClaim(claim, outcome, opts);
    if (r !== 'finalized') {
      console.warn(`[rpaWorker] finalise ${r} action=${task.action_id} outcome=${outcome} (claim left to expire -> parked unknown)`);
    }
  };

  // Environment gate: fail fast when Playwright isn't ready. Nothing ran, so
  // the claimed row is released for a later retry (not attempted).
  const ready = await rpaEnvReady();
  if (isProbeFailure(ready)) {
    await release('failed', { error: `RPA_ENV_NOT_READY:${ready.reason}`, retryDelaySeconds: 120 });
    return { success: false, not_attempted: true, error: `RPA_ENV_NOT_READY:${ready.reason}` };
  }

  // Per-org backpressure gate. Each tenant gets its own READY / DEGRADED
  // / BLOCKED state; a noisy org cannot push others into BLOCKED.
  const admission = await admitRpaTask({ organization_id: task.organization_id });
  if (!admission.admit) {
    await release('failed', { error: `RPA_DEFERRED:${admission.reason || admission.status}`, retryDelaySeconds: 60 });
    return { success: false, not_attempted: true, error: `RPA_DEFERRED:${admission.status}` };
  }

  startRpaWorker(async (queuedTask, ctx) => {
    const taskHandler = handlers[normalizePlatform(queuedTask.platform)];
    if (!taskHandler) {
      return { success: false, error: 'RPA_PLATFORM_NOT_SUPPORTED' };
    }
    return taskHandler(queuedTask, ctx);
  });

  let result: RpaResult;
  try {
    // Review S-1: the in-process queue re-checks this claim's lease
    // immediately before the handler (and the Playwright handler again inside
    // its heavy-job slot); a lease lost while waiting means nothing runs.
    result = await enqueueRpaTask(task, rpaRunContextForClaim(claim));
  } catch (error: any) {
    // enqueueRpaTask rejects only before the handler runs (worker not started).
    result = { success: false, not_attempted: true, error: error?.message || 'RPA_QUEUE_FAILED' };
  }

  if (result.claim_lost === true) {
    // Never attempted. If this process still holds the (expired) token, give
    // the row back as not attempted: the worker flush runs it later, behind its
    // own gate (kill switch, approval of record, contact governance). If it was
    // already parked by another tick it stays parked; it was not run here.
    const rel = await releaseRpaClaimNotAttempted(claim, 'LEASE_CHECK_DIRECT_PATH');
    console.warn(`[rpaWorker] claim lost before run action=${task.action_id}; NOT run, release=${rel}`);
    if (rel === 'released') {
      return { success: false, not_attempted: true, queued_for_worker: true, claim_lost: true, error: `${RPA_CLAIM_LOST}:QUEUED_FOR_WORKER` };
    }
    return { success: false, not_attempted: true, claim_lost: true, error: `${RPA_CLAIM_LOST}:${rel === 'not_held' ? 'PARKED' : 'RELEASE_FAILED'}` };
  }

  if (result.success) {
    await release('succeeded');
  } else if (result.outcome_unknown) {
    await release('unknown', { error: result.error ?? 'UNKNOWN' });
  } else {
    // A definite in-process failure is final for this direct path (it was
    // already re-run once in-process, as before); the row is retired, not
    // re-queued, so the caller's 'failed' is the whole story.
    await release('failed', { error: result.error ?? 'RPA_EXECUTION_FAILED', terminal: true });
  }
  return result;
};
