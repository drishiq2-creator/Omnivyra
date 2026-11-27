import { supabase } from '../db/supabaseClient';
import { executeAction } from './communityAiActionExecutor';
import { logCommunityAiActionEvent } from './communityAiActionLogService';
import { randomUUID } from 'crypto';
import { notifyCommunityAi } from './communityAiNotificationService';
import { sendCommunityAiWebhooks } from './communityAiWebhookService';
import { persistExecutionResult } from './communityAiActionExecutor';
import { getPlaybookById } from './playbooks/playbookService';
import { validateActionAgainstPlaybook } from './playbooks/playbookValidator';
import { getToken } from './platformTokenService';
import { resolveCommunityAiPlatformPolicy, decideCommunityAiAutomatedTick } from './communityAiPlatformPolicyService';
import { canExecuteAction } from './executionGuardrailService';
import { ownedDbTable } from '../db/writeOwner';

type SchedulerResult = {
  processed: number;
  executed: number;
  failed: number;
};

const loadHistoryMetrics = async (
  tenantId: string,
  organizationId: string,
  playbookId: string
) => {
  try {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayStartIso = dayStart.toISOString();

    const { data: replyRows } = await ownedDbTable('community_ai_actions')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('playbook_id', playbookId)
      .eq('status', 'executed')
      .eq('action_type', 'reply')
      .gte('updated_at', hourAgo);

    const { data: followRows } = await ownedDbTable('community_ai_actions')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('playbook_id', playbookId)
      .eq('status', 'executed')
      .eq('action_type', 'follow')
      .gte('updated_at', dayStartIso);

    const { data: actionRows } = await ownedDbTable('community_ai_actions')
      .select('id, intent_classification')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('playbook_id', playbookId)
      .eq('status', 'executed')
      .gte('updated_at', dayStartIso);

    const networkActionsToday =
      (actionRows || []).filter(
        (row: any) => row?.intent_classification?.primary_intent === 'network_expansion'
      ).length ?? 0;

    return {
      replies_last_hour: replyRows?.length ?? 0,
      follows_today: followRows?.length ?? 0,
      actions_today: actionRows?.length ?? 0,
      networkActionsToday,
    };
  } catch (error: any) {
    console.warn('PLAYBOOK_HISTORY_METRICS_FAILED', error?.message || error);
    return {
      replies_last_hour: 0,
      follows_today: 0,
      actions_today: 0,
    };
  }
};

/** SF-1: how long the scheduler's claim on a row lives if the tick dies mid-run (then it is claimable again). */
const SCHEDULER_CLAIM_LEASE_MS = 15 * 60 * 1000;

export const runCommunityAiScheduler = async (now = new Date()): Promise<SchedulerResult> => {
  // Round 28 (review P-1): fail-closed tick gate. A missing policy row, an
  // unreadable policy or execution_enabled=false stops the scheduler before
  // any row is read. Per-row approval of record is enforced by the executor.
  const tick = decideCommunityAiAutomatedTick(await resolveCommunityAiPlatformPolicy(), 'scheduler');
  if (tick.allowed === false) {
    console.debug('COMMUNITY_AI_PLATFORM_POLICY_BLOCK', {
      reason: tick.reason_code,
      source: 'scheduler',
    });
    await ownedDbTable('audit_logs').insert({
      actor_user_id: null,
      action: 'COMMUNITY_AI_PLATFORM_POLICY_BLOCK',
      metadata: {
        policy_flag: tick.policy_flag === 'policy_unreadable' ? 'execution_enabled' : tick.policy_flag,
        reason_code: tick.reason_code,
        policy_state: tick.policy_state,
        source: 'scheduler',
      },
      created_at: new Date().toISOString(),
    });
    return { processed: 0, executed: 0, failed: 0 };
  }

  const cutoff = now.toISOString();
  const { data: actions, error } = await ownedDbTable('community_ai_actions')
    .select('*')
    .eq('status', 'approved')
    .gte('scheduled_at', '1970-01-01T00:00:00.000Z')
    .lte('scheduled_at', cutoff);

  if (error || !actions) {
    console.warn('COMMUNITY_AI_SCHEDULER_LOAD_FAILED', error?.message);
    return { processed: 0, executed: 0, failed: 0 };
  }

  let executed = 0;
  let failed = 0;

  for (const action of actions) {
    if (!action.tenant_id || !action.organization_id) {
      failed += 1;
      await persistExecutionResult({
        actionId: action.id,
        organizationId: action.organization_id || 'unknown',
        correlationId: randomUUID(),
        result: { ok: false, status: 'failed', error: 'TENANT_SCOPE_MISSING', response: { source: 'scheduler' } },
        rowHint: { platform: action.platform, action_type: action.action_type, target_id: action.target_id },
      });
      await logCommunityAiActionEvent({
        action_id: action.id,
        tenant_id: action.tenant_id || 'unknown',
        organization_id: action.organization_id || 'unknown',
        event_type: 'failed',
        event_payload: { error: 'TENANT_SCOPE_MISSING' },
      });
      continue;
    }

    if (action.intent_classification?.primary_intent === 'network_expansion') {
      await logCommunityAiActionEvent({
        action_id: action.id,
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        event_type: 'skipped',
        event_payload: {
          reason: 'PHASE_5B_OBSERVATION_LOCK',
        },
      });
      continue;
    }

    if (!action.playbook_id) {
      failed += 1;
      const failure = { ok: false, status: 'failed' as const, error: 'PLAYBOOK_REQUIRED', response: { source: 'scheduler' } };
      await persistExecutionResult({
        actionId: action.id,
        organizationId: action.organization_id,
        correlationId: randomUUID(),
        result: failure,
        rowHint: { platform: action.platform, action_type: action.action_type, target_id: action.target_id },
      });
      await logCommunityAiActionEvent({
        action_id: action.id,
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        event_type: 'failed',
        event_payload: failure,
      });
      await notifyCommunityAi({
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        action_id: action.id,
        event_type: 'failed',
        message: `Scheduled action failed on ${action.platform}`,
      });
      void sendCommunityAiWebhooks({
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        event_type: 'failed',
        action_id: action.id,
        message: `Scheduled action failed on ${action.platform}`,
        metadata: { platform: action.platform, action_type: action.action_type },
      });
      continue;
    }

    let playbook = null;
    try {
      playbook = await getPlaybookById(
        action.playbook_id,
        action.tenant_id,
        action.organization_id
      );
    } catch (error: any) {
      failed += 1;
      const failure = { ok: false, status: 'failed' as const, error: 'PLAYBOOK_NOT_FOUND', response: { source: 'scheduler' } };
      await persistExecutionResult({
        actionId: action.id,
        organizationId: action.organization_id,
        correlationId: randomUUID(),
        result: failure,
        rowHint: { platform: action.platform, action_type: action.action_type, target_id: action.target_id },
      });
      await logCommunityAiActionEvent({
        action_id: action.id,
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        event_type: 'failed',
        event_payload: failure,
      });
      await notifyCommunityAi({
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        action_id: action.id,
        event_type: 'failed',
        message: `Scheduled action failed on ${action.platform}`,
      });
      void sendCommunityAiWebhooks({
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        event_type: 'failed',
        action_id: action.id,
        message: `Scheduled action failed on ${action.platform}`,
        metadata: { platform: action.platform, action_type: action.action_type },
      });
      continue;
    }

    const historyMetrics = await loadHistoryMetrics(
      action.tenant_id,
      action.organization_id,
      action.playbook_id
    );
    const playbookValidation = validateActionAgainstPlaybook(
      {
        action_type: action.action_type,
        text: action.suggested_text,
        execution_mode: action.execution_mode || 'manual',
        risk_level: action.risk_level,
        intent_classification: action.intent_classification || null,
      },
      playbook,
      historyMetrics
    );
    if (!playbookValidation.allowed) {
      const reason = playbookValidation.reason || 'PLAYBOOK_VIOLATION';
      const skipReasons = new Set([
        'NETWORK_DAILY_LIMIT_EXCEEDED',
        'OUTSIDE_ALLOWED_HOURS',
        'AUTOMATION_LEVEL_OBSERVE',
        'AUTOMATION_LEVEL_ASSIST_LIMIT',
        'AUTOMATION_LEVEL_AUTOMATE_LIMIT',
      ]);
      if (skipReasons.has(reason)) {
        await persistExecutionResult({
          actionId: action.id,
          organizationId: action.organization_id,
          correlationId: randomUUID(),
          result: { ok: false, status: 'skipped', reason, response: { source: 'scheduler' } },
          rowHint: { platform: action.platform, action_type: action.action_type, target_id: action.target_id },
        });
        await logCommunityAiActionEvent({
          action_id: action.id,
          tenant_id: action.tenant_id,
          organization_id: action.organization_id,
          event_type: 'skipped',
          event_payload: { reason },
        });
        continue;
      }

      failed += 1;
      const failure = {
        ok: false,
        status: 'failed' as const,
        error: reason,
        response: { source: 'scheduler' },
      };
      await persistExecutionResult({
        actionId: action.id,
        organizationId: action.organization_id,
        correlationId: randomUUID(),
        result: failure,
        rowHint: { platform: action.platform, action_type: action.action_type, target_id: action.target_id },
      });
      await logCommunityAiActionEvent({
        action_id: action.id,
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        event_type: 'failed',
        event_payload: failure,
      });
      await notifyCommunityAi({
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        action_id: action.id,
        event_type: 'failed',
        message: `Scheduled action failed on ${action.platform}`,
      });
      void sendCommunityAiWebhooks({
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        event_type: 'failed',
        action_id: action.id,
        message: `Scheduled action failed on ${action.platform}`,
        metadata: { platform: action.platform, action_type: action.action_type },
      });
      continue;
    }

    const executionMode = (action.execution_mode || 'manual').toString().trim().toLowerCase();
    if (executionMode === 'api') {
      let tokenRow: { access_token?: string | null } | null = null;
      try {
        tokenRow = await getToken(
          action.tenant_id,
          action.organization_id,
          (action.platform || '').toString().trim().toLowerCase()
        );
      } catch (error: any) {
        tokenRow = null;
      }
      if (!tokenRow?.access_token) {
        failed += 1;
        const failure = {
          ok: false,
          status: 'failed' as const,
          error: 'Platform not connected',
          response: { source: 'scheduler' },
        };
        await persistExecutionResult({
          actionId: action.id,
          organizationId: action.organization_id,
          correlationId: randomUUID(),
          result: failure,
          rowHint: { platform: action.platform, action_type: action.action_type, target_id: action.target_id },
        });
        await logCommunityAiActionEvent({
          action_id: action.id,
          tenant_id: action.tenant_id,
          organization_id: action.organization_id,
          event_type: 'failed',
          event_payload: failure,
        });
        await notifyCommunityAi({
          tenant_id: action.tenant_id,
          organization_id: action.organization_id,
          action_id: action.id,
          event_type: 'failed',
          message: `Scheduled action failed on ${action.platform}`,
        });
        void sendCommunityAiWebhooks({
          tenant_id: action.tenant_id,
          organization_id: action.organization_id,
          event_type: 'failed',
          action_id: action.id,
          message: `Scheduled action failed on ${action.platform}`,
          metadata: { platform: action.platform, action_type: action.action_type },
        });
        continue;
      }
    }

    const guardrail = await canExecuteAction(
      {
        id: action.id,
        company_id: action.organization_id,
        tenant_id: action.tenant_id,
        organization_id: action.organization_id,
        platform: action.platform,
        action_type: action.action_type,
        target_id: action.target_id,
      },
      { source: 'scheduler' }
    );
    if (!guardrail.allowed) {
      // 'skipped_guardrail' is a scheduler-specific status retained for
      // backwards compatibility. Route through persistExecutionResult so the
      // central pipeline owns every row write; the status CHECK still
      // permits the legacy value.
      await persistExecutionResult({
        actionId: action.id,
        organizationId: action.organization_id,
        correlationId: randomUUID(),
        result: {
          ok: false,
          status: 'skipped',
          reason: guardrail.reason ?? 'GUARDRAIL',
          response: { source: 'scheduler', guardrail_reason: guardrail.reason ?? null },
        },
        rowHint: { platform: action.platform, action_type: action.action_type, target_id: action.target_id },
      });
      continue;
    }

    // Review SF-1: claim the row before executing, so a row the user also
    // executes by hand (B-2: refused -> approved -> execute again, while it
    // carries a due scheduled_at) runs exactly once.
    // The claim is the dispatch LEASE, not a status change: the real
    // community_ai_actions_status_check (supabase/_schema/baseline.sql) admits
    // only pending/approved/executed/failed/skipped, so 'executing' would be
    // refused (backend/tests/realschema/r3comm_* proves it). Tenant/org scoped,
    // only from 'approved', only when the row carries NO lease (dispatch_lease_id
    // null; an expired-but-unreleased lease is not free). The manual execute
    // route's CAS requires the same condition, so exactly one side gets the row. 0 rows
    // or an error = skip, nothing executed.
    const leaseId = randomUUID();
    const claimAtMs = Date.now();
    const { data: claimedRow, error: claimError } = await ownedDbTable('community_ai_actions')
      .update({
        dispatch_lease_id: leaseId,
        dispatch_lease_holder_id: 'community_ai_scheduler',
        dispatch_lease_expires_at: new Date(claimAtMs + SCHEDULER_CLAIM_LEASE_MS).toISOString(),
        updated_at: new Date(claimAtMs).toISOString(),
      })
      .eq('id', action.id)
      .eq('tenant_id', action.tenant_id)
      .eq('organization_id', action.organization_id)
      .eq('status', 'approved')
      // Only a row with NO lease at all. An expired lease that was never released (an extension that may have
      // sent and lost its result, a tick that died mid-execute) is NOT free: re-claiming it could send twice.
      // Every proper release nulls dispatch_lease_id (releaseSchedulerLease below, the extension's chain advance,
      // terminal persistExecutionResult, the reaper).
      .is('dispatch_lease_id', null)
      .select('id, status')
      .maybeSingle();
    if (claimError || !claimedRow) {
      if (claimError) console.warn('COMMUNITY_AI_SCHEDULER_CLAIM_FAILED', action.id, claimError.message);
      continue;
    }
    const releaseSchedulerLease = async () => {
      // A terminal persist already cleared it; a non-terminal one ('pending' for
      // the extension) must not keep the scheduler's lease. Only OUR lease.
      try {
        await ownedDbTable('community_ai_actions')
          .update({ dispatch_lease_id: null, dispatch_lease_holder_id: null, dispatch_lease_expires_at: null })
          .eq('id', action.id)
          .eq('dispatch_lease_id', leaseId);
      } catch (e: any) {
        console.warn('COMMUNITY_AI_SCHEDULER_LEASE_RELEASE_FAILED', action.id, e?.message || e);
      }
    };

    // Executor owns the terminal row write (persist:true). The scheduler
    // simply observes the outcome; notify + webhook fan-out lives inside
    // the executor so every entry point emits identically.
    let result: Awaited<ReturnType<typeof executeAction>>;
    try {
      result = await executeAction(action, true, {
        notify: true,
        webhook: true,
        source: 'scheduler',
        persist: true,
      });
    } finally {
      await releaseSchedulerLease();
    }

    if (result.status === 'skipped' && result.reason === 'HUMAN_APPROVAL_REQUIRED') {
      continue;
    }

    const nextStatus =
      result.status === 'skipped' ? 'skipped' : result.ok ? 'executed' : 'failed';
    if (result.ok) executed += 1;
    else if (result.status !== 'skipped') failed += 1;

    await logCommunityAiActionEvent({
      action_id: action.id,
      tenant_id: action.tenant_id,
      organization_id: action.organization_id,
      event_type: nextStatus === 'executed' ? 'executed' : nextStatus === 'skipped' ? 'skipped' : 'failed',
      event_payload: result,
    });
  }

  return { processed: actions.length, executed, failed };
};
