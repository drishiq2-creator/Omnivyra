import { supabase } from '../db/supabaseClient';

type CommunityAiPlatformPolicy = {
  execution_enabled: boolean;
  auto_rules_enabled: boolean;
  require_human_approval: boolean;
  updated_at: string | null;
  updated_by: string | null;
};

/**
 * Applies when the read succeeds and no policy row is configured. A missing
 * policy must not authorise automated execution, so auto rules are off;
 * manual (human-initiated) execution keeps its existing defaults.
 *
 * This is what the legacy, initiator-blind getter (getCommunityAiPlatformPolicy)
 * still returns for a missing row, unchanged, so manual human-initiated sends
 * (engagement like/reply/DM pass no approved_at to the executor) keep working.
 * The fail-closed kill switch for AUTOMATED initiators is
 * evaluateCommunityAiExecutionPolicy below, which knows both the policy state
 * (configured / missing_row / unreadable) and the initiator.
 */
const DEFAULT_POLICY: CommunityAiPlatformPolicy = {
  execution_enabled: true,
  auto_rules_enabled: false,
  require_human_approval: false,
  updated_at: null,
  updated_by: null,
};

/**
 * Fail-closed policy used ONLY when the policy store cannot be read (the
 * query returned an error or threw). An unreadable policy must never
 * authorise automatic execution: execution is off, auto rules are off and
 * human approval is required. This is distinct from DEFAULT_POLICY, which
 * applies when the read succeeds and no policy row is configured.
 *
 * Not cached, so the next call retries the read.
 */
const UNREADABLE_POLICY: CommunityAiPlatformPolicy = {
  execution_enabled: false,
  auto_rules_enabled: false,
  require_human_approval: true,
  updated_at: null,
  updated_by: null,
};

/** Where the effective policy came from. */
type CommunityAiPolicyState = 'configured' | 'missing_row' | 'unreadable';

type CommunityAiPolicyResolution = {
  policy: CommunityAiPlatformPolicy;
  state: CommunityAiPolicyState;
};

const failClosed = (
  reason: 'query_error' | 'query_threw',
  code: unknown
): CommunityAiPolicyResolution => {
  // Log the reason and the driver error code only: no message, no payload.
  console.warn('COMMUNITY_AI_POLICY_UNREADABLE_FAIL_CLOSED', {
    reason,
    code: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
  });
  return { policy: { ...UNREADABLE_POLICY }, state: 'unreadable' };
};

/** Test-only: clear the in-process policy cache. */
export const __resetCommunityAiPlatformPolicyCacheForTests = () => {
  cachedResolution = null;
  cacheExpiresAt = 0;
};

const CACHE_TTL_MS = 60_000;
let cachedResolution: CommunityAiPolicyResolution | null = null;
let cacheExpiresAt = 0;

/**
 * Reads the policy and reports its state. `unreadable` is never cached (the
 * next call retries); `configured` and `missing_row` are cached for 60 s.
 */
export const resolveCommunityAiPlatformPolicy = async (): Promise<CommunityAiPolicyResolution> => {
  const now = Date.now();
  if (cachedResolution && cacheExpiresAt > now) {
    return cachedResolution;
  }

  try {
    const { data, error } = await supabase
      .from('community_ai_platform_policy')
      .select('execution_enabled, auto_rules_enabled, require_human_approval, updated_at, updated_by')
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error) {
      return failClosed('query_error', (error as { code?: unknown })?.code);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      cachedResolution = {
        state: 'configured',
        policy: {
          execution_enabled:
            typeof row.execution_enabled === 'boolean'
              ? row.execution_enabled
              : DEFAULT_POLICY.execution_enabled,
          // Anything but an explicit true is not an authorisation to automate.
          auto_rules_enabled: row.auto_rules_enabled === true,
          require_human_approval:
            typeof row.require_human_approval === 'boolean'
              ? row.require_human_approval
              : DEFAULT_POLICY.require_human_approval,
          updated_at: row.updated_at ?? null,
          updated_by: row.updated_by ?? null,
        },
      };
      cacheExpiresAt = now + CACHE_TTL_MS;
      return cachedResolution;
    }
  } catch (error) {
    return failClosed('query_threw', (error as { code?: unknown })?.code);
  }

  // Read succeeded and no policy row is configured: DEFAULT_POLICY applies
  // to the legacy getter (see UNREADABLE_POLICY for the error case).
  cachedResolution = { state: 'missing_row', policy: DEFAULT_POLICY };
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedResolution;
};

/**
 * Legacy, initiator-blind getter. Behaviour unchanged: a missing row returns
 * DEFAULT_POLICY, an unreadable store returns UNREADABLE_POLICY. Callers that
 * decide whether to execute should use evaluateCommunityAiExecutionPolicy.
 */
export const getCommunityAiPlatformPolicy = async (): Promise<CommunityAiPlatformPolicy> =>
  (await resolveCommunityAiPlatformPolicy()).policy;

// ── Kill switch ─────────────────────────────────────────────────────────────

/**
 * Who is asking to execute.
 *  - manual:            a human clicked execute/send for this one action (the
 *                       click is the approval of the moment).
 *  - bulk:              a human started a bulk send of selected items.
 *  - auto:              auto rules / automation service; no human in the loop.
 *  - scheduler:         the community scheduler cron dispatching due rows.
 *  - rpa_retry:         the RPA retry-queue flush re-executing a row.
 *  - extension_handout: the extension lease hand-out (last point before the
 *                       browser sends a queued row).
 */
type CommunityAiExecutionInitiator =
  | 'manual'
  | 'bulk'
  | 'auto'
  | 'scheduler'
  | 'rpa_retry'
  | 'extension_handout';

const HUMAN_INITIATED: ReadonlySet<string> = new Set(['manual', 'bulk']);
const NO_HUMAN_PRESENT: ReadonlySet<string> = new Set(['auto', 'scheduler', 'rpa_retry']);
const KNOWN_INITIATORS: ReadonlySet<string> = new Set([
  ...HUMAN_INITIATED,
  ...NO_HUMAN_PRESENT,
  'extension_handout',
]);

type CommunityAiPolicyBlockReason =
  | 'policy_unreadable_fail_closed'
  | 'policy_missing_fail_closed'
  | 'execution_disabled'
  | 'auto_rules_disabled'
  | 'approval_required'
  | 'initiator_unknown';

type CommunityAiPolicyFlag =
  | 'policy_unreadable'
  | 'policy_missing'
  | 'execution_enabled'
  | 'auto_rules_enabled'
  | 'require_human_approval'
  | 'approval_of_record'
  | 'initiator';

type CommunityAiPolicyDecision =
  | {
      allowed: true;
      reason_code: null;
      policy_state: CommunityAiPolicyState;
      initiator: CommunityAiExecutionInitiator;
    }
  | {
      allowed: false;
      reason_code: CommunityAiPolicyBlockReason;
      policy_state: CommunityAiPolicyState;
      initiator: CommunityAiExecutionInitiator;
      /** Which flag or rule refused, for audit rows / event payloads. */
      policy_flag: CommunityAiPolicyFlag;
    };

type CommunityAiPolicyEvaluationInput = {
  initiator: CommunityAiExecutionInitiator;
  /** The action of record's approved_at (a persisted human approval). */
  approved_at?: string | null;
};

const hasApproval = (approvedAt: string | null | undefined) =>
  typeof approvedAt === 'string' && approvedAt.trim().length > 0;

/**
 * Pure decision over an already-resolved policy.
 *
 * unreadable  -> every initiator refused: policy_unreadable_fail_closed.
 *
 * missing_row -> automated execution is OFF and approval is required:
 *   - auto, scheduler, rpa_retry (no human present): refused with
 *     policy_missing_fail_closed, even when approved_at is set;
 *   - extension_handout: allowed only with approved_at (human-initiated
 *     sends stamp it when the row is inserted); otherwise
 *     policy_missing_fail_closed;
 *   - manual, bulk (a human clicked): allowed. The click is the approval;
 *     this keeps the documented "manual (human-initiated) execution keeps
 *     its existing defaults".
 *
 * configured  -> the row is honoured as configured:
 *   - execution_enabled !== true: everything refused, execution_disabled;
 *   - auto with auto_rules_enabled !== true: auto_rules_disabled;
 *   - scheduler / rpa_retry without approved_at: approval_required
 *     (approval of record, as the executor and retry gates already require);
 *   - require_human_approval and no approved_at: approval_required for every
 *     initiator, manual included. An explicitly approved action passes.
 *
 * An initiator outside the known set is refused (initiator_unknown).
 */
export const decideCommunityAiExecutionPolicy = (
  resolution: CommunityAiPolicyResolution,
  input: CommunityAiPolicyEvaluationInput
): CommunityAiPolicyDecision => {
  const { policy, state } = resolution;
  const initiator = input?.initiator;
  const approved = hasApproval(input?.approved_at);
  const refuse = (
    reason_code: CommunityAiPolicyBlockReason,
    policy_flag: CommunityAiPolicyFlag
  ): CommunityAiPolicyDecision => ({ allowed: false, reason_code, policy_state: state, initiator, policy_flag });
  const allow = (): CommunityAiPolicyDecision => ({ allowed: true, reason_code: null, policy_state: state, initiator });

  // Anything but a successful read (configured / missing_row) is unreadable.
  if (state !== 'configured' && state !== 'missing_row') {
    return refuse('policy_unreadable_fail_closed', 'policy_unreadable');
  }
  if (!KNOWN_INITIATORS.has(String(initiator))) {
    return refuse('initiator_unknown', 'initiator');
  }

  if (state === 'missing_row') {
    if (NO_HUMAN_PRESENT.has(initiator)) return refuse('policy_missing_fail_closed', 'policy_missing');
    if (initiator === 'extension_handout' && !approved) {
      return refuse('policy_missing_fail_closed', 'policy_missing');
    }
    return allow();
  }

  if (policy.execution_enabled !== true) return refuse('execution_disabled', 'execution_enabled');
  if (initiator === 'auto' && policy.auto_rules_enabled !== true) {
    return refuse('auto_rules_disabled', 'auto_rules_enabled');
  }
  if ((initiator === 'scheduler' || initiator === 'rpa_retry') && !approved) {
    return refuse('approval_required', 'approval_of_record');
  }
  if (policy.require_human_approval && !approved) {
    return refuse('approval_required', 'require_human_approval');
  }
  return allow();
};

/**
 * Kill-switch entry point: resolve the policy, then decide for one initiator.
 * Every refusal carries an auditable reason_code and policy_flag.
 */
export const evaluateCommunityAiExecutionPolicy = async (
  input: CommunityAiPolicyEvaluationInput
): Promise<CommunityAiPolicyDecision> =>
  decideCommunityAiExecutionPolicy(await resolveCommunityAiPlatformPolicy(), input);

/**
 * Tick-level gate for an automated batch (scheduler tick, RPA retry flush,
 * auto-rule evaluation) BEFORE any row is read: may this automation run at
 * all? Approval is per action and is decided later with
 * decideCommunityAiExecutionPolicy against each row's approved_at.
 *   unreadable  -> policy_unreadable_fail_closed
 *   missing_row -> policy_missing_fail_closed
 *   configured  -> execution_disabled / auto_rules_disabled (auto only) / allowed
 */
export const decideCommunityAiAutomatedTick = (
  resolution: CommunityAiPolicyResolution,
  initiator: 'auto' | 'scheduler' | 'rpa_retry'
): CommunityAiPolicyDecision => {
  const { policy, state } = resolution;
  const refuse = (
    reason_code: CommunityAiPolicyBlockReason,
    policy_flag: CommunityAiPolicyFlag
  ): CommunityAiPolicyDecision => ({ allowed: false, reason_code, policy_state: state, initiator, policy_flag });
  if (state !== 'configured' && state !== 'missing_row') {
    return refuse('policy_unreadable_fail_closed', 'policy_unreadable');
  }
  if (!NO_HUMAN_PRESENT.has(String(initiator))) return refuse('initiator_unknown', 'initiator');
  if (state === 'missing_row') return refuse('policy_missing_fail_closed', 'policy_missing');
  if (policy.execution_enabled !== true) return refuse('execution_disabled', 'execution_enabled');
  if (initiator === 'auto' && policy.auto_rules_enabled !== true) {
    return refuse('auto_rules_disabled', 'auto_rules_enabled');
  }
  return { allowed: true, reason_code: null, policy_state: state, initiator };
};

export type {
  CommunityAiPlatformPolicy,
  CommunityAiPolicyState,
  CommunityAiPolicyResolution,
  CommunityAiExecutionInitiator,
  CommunityAiPolicyBlockReason,
  CommunityAiPolicyFlag,
  CommunityAiPolicyDecision,
  CommunityAiPolicyEvaluationInput,
};
