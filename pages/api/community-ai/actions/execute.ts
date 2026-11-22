import { blockedReasonCode } from '../../../../lib/communityAi/blockedReason';
import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../../../backend/db/supabaseClient';
import { getCommunityAiActionById } from '../../../../backend/db/communityAiActionStore';
import { enforceActionRole, requireTenantScope } from '../utils';
import { COMMUNITY_AI_CAPABILITIES } from '../../../../backend/services/rbac/communityAiCapabilities';
import { executeAction } from '../../../../backend/services/communityAiActionExecutor';
import { logCommunityAiActionEvent } from '../../../../backend/services/communityAiActionLogService';
import { notifyCommunityAi } from '../../../../backend/services/communityAiNotificationService';
import { sendCommunityAiWebhooks } from '../../../../backend/services/communityAiWebhookService';
import { getPlaybookById } from '../../../../backend/services/playbooks/playbookService';
import {
  validateActionAgainstPlaybook,
} from '../../../../backend/services/playbooks/playbookValidator';

type ExecuteRequest = {
  tenant_id?: string;
  organization_id?: string;
  action_id?: string;
  approved?: boolean;
  execution_mode?: 'manual' | 'api' | 'rpa' | 'browser' | string;
  final_text?: string;
  idempotency_key?: string;
};

// Statuses from which an action may legally transition into execution.
const EXECUTABLE_FROM_STATUSES = new Set(['pending', 'approved', 'scheduled']);

function readIdempotencyKey(req: NextApiRequest, body: ExecuteRequest): string | null {
  const headerVal = req.headers['idempotency-key'];
  const fromHeader = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const candidate = (fromHeader || body.idempotency_key || '').toString().trim();
  return candidate.length > 0 ? candidate : null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const scope = await requireTenantScope(req, res);
  if (!scope) return;

  const roleGate = await enforceActionRole({
    req,
    res,
    companyId: scope.organizationId,
    allowedRoles: [...COMMUNITY_AI_CAPABILITIES.EXECUTE_ACTIONS],
  });
  if (!roleGate) return;

  const body = (req.body || {}) as ExecuteRequest;
  const actionId = body.action_id;
  if (!actionId) {
    return res.status(400).json({ error: 'action_id is required' });
  }
  if (body.approved !== true) {
    return res.status(403).json({ error: 'APPROVAL_REQUIRED' });
  }

  const idempotencyKey = readIdempotencyKey(req, body);

  // Idempotent replay: a prior call with the same key returns its terminal
  // result rather than re-executing. Scoped to (organization_id, key) by the
  // unique index in 20260522_community_ai_execution_integrity.sql.
  if (idempotencyKey) {
    const { data: prior } = await supabase
      .from('community_ai_actions')
      .select('id, status, execution_result, execution_mode')
      .eq('organization_id', scope.organizationId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (prior && prior.id) {
      return res.status(200).json({
        tenant_id: scope.tenantId,
        organization_id: scope.organizationId,
        action_id: prior.id,
        status: prior.status,
        execution: prior.execution_result,
        idempotent: true,
      });
    }
  }

  const { data: action, error } = await getCommunityAiActionById(actionId);

  if (error || !action) {
    return res.status(404).json({ error: 'ACTION_NOT_FOUND' });
  }

  if (action.tenant_id !== scope.tenantId || action.organization_id !== scope.organizationId) {
    return res.status(403).json({ error: 'TENANT_SCOPE_VIOLATION' });
  }

  if (!action.status || !EXECUTABLE_FROM_STATUSES.has(action.status)) {
    return res.status(409).json({ error: 'ACTION_NOT_PENDING', current_status: action.status });
  }

  // Approval-integrity gate: any human-approval-required action MUST carry an
  // approved_at before it may execute. Mirrors the DB CHECK constraint so the
  // API can return a precise error rather than a generic CHECK violation.
  if (action.requires_human_approval === true && !action.approved_at) {
    return res.status(403).json({ error: 'APPROVAL_REQUIRED', reason: 'NOT_APPROVED' });
  }

  // "Message on LinkedIn" (owner 2026-11-22): a new DM to a lead is sent ONLY by the requesting user's Sales Navigator
  // extension (browser), whatever the caller asks for, and exactly with the words the requester wrote and the
  // approver approved - the executor may not change the text sent from someone else's LinkedIn account.
  const isLinkedInNewDm = Boolean((action as any).dm_lead_id);
  if (isLinkedInNewDm && body.final_text != null && String(body.final_text) !== String(action.suggested_text ?? '')) {
    return res.status(409).json({ error: 'NEW_DM_TEXT_CHANGE_NOT_ALLOWED' });
  }
  // A new DM is queued for its extension exactly once: only from 'approved', never claimed. Once queued it is stored as
  // 'pending' with approved_at set; executing it again would rewrite its job under a running extension (review 3 N-a).
  if (isLinkedInNewDm && (action.status !== 'approved' || (action as any).dispatch_lease_id)) {
    return res.status(409).json({ error: 'NEW_DM_ALREADY_QUEUED', current_status: action.status });
  }

  const requestedMode = (body.execution_mode || action.execution_mode || '').toString();
  // Manual is the human-driven simulation path; everything else is delegated
  // to the central router inside the executor (which itself handles fallback).
  const executionMode = isLinkedInNewDm ? 'browser' : (requestedMode || 'manual');

  const finalText = (body.final_text ?? action.suggested_text ?? '').toString();
  if (action.action_type === 'reply' && finalText.trim().length === 0) {
    return res.status(400).json({ error: 'FINAL_TEXT_REQUIRED' });
  }

  let playbook: any = null;
  if (action.playbook_id) {
    try {
      playbook = await getPlaybookById(
        action.playbook_id,
        scope.tenantId,
        scope.organizationId
      );
    } catch {
      return res.status(404).json({ error: 'PLAYBOOK_NOT_FOUND' });
    }
  }
  const validation = validateActionAgainstPlaybook(
    {
      action_type: action.action_type as 'like' | 'reply' | 'schedule' | 'follow' | 'share',
      text: finalText,
      execution_mode: executionMode,
      risk_level: action.risk_level as 'high' | 'medium' | 'low',
    },
    playbook,
    null
  );
  if (!validation.allowed) {
    return res.status(400).json({
      error: 'PLAYBOOK_VIOLATION',
      reason: validation.reason || 'Playbook validation failed.',
    });
  }

  // ── Atomic state-machine transition: pending/approved/scheduled → executing.
  // Persists the executor's `execution_mode` choice up front and stamps
  // `idempotency_key` (race-safe via the unique index — a concurrent caller
  // with the same key fails the update and we surface the prior row).
  const transitionAt = new Date().toISOString();
  const transitionPayload: Record<string, any> = {
    status: 'executing',
    execution_mode: executionMode,
    final_text: finalText,
    updated_at: transitionAt,
  };
  // A new DM always carries its own key (newdm:<id>), stamped here and passed to the executor alike.
  if (isLinkedInNewDm) transitionPayload.idempotency_key = `newdm:${action.id}`;
  else if (idempotencyKey) transitionPayload.idempotency_key = idempotencyKey;

  const transition = supabase
    .from('community_ai_actions')
    .update(transitionPayload)
    .eq('id', actionId);
  const { data: claimed, error: claimError } = await (isLinkedInNewDm
    ? transition.eq('status', 'approved').is('dispatch_lease_id', null)
    : transition.in('status', Array.from(EXECUTABLE_FROM_STATUSES)))
    .select('id, status')
    .maybeSingle();

  if (claimError) {
    // Most likely an idempotency-key uniqueness collision. Resolve by
    // returning the prior row's terminal state.
    if (idempotencyKey) {
      const { data: prior } = await supabase
        .from('community_ai_actions')
        .select('id, status, execution_result')
        .eq('organization_id', scope.organizationId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (prior?.id) {
        return res.status(200).json({
          action_id: prior.id,
          status: prior.status,
          execution: prior.execution_result,
          idempotent: true,
        });
      }
    }
    console.error('[community-ai/execute] state transition failed:', claimError.message);
    return res.status(500).json({ error: 'STATE_TRANSITION_FAILED' });
  }
  if (!claimed) {
    return res.status(409).json({ error: 'ACTION_NOT_PENDING' });
  }

  const approvedAtIso = (action.approved_at as string | null | undefined) ?? null;
  await logCommunityAiActionEvent({
    action_id: actionId,
    tenant_id: scope.tenantId,
    organization_id: scope.organizationId,
    event_type: 'approved',
    event_payload: {
      approved: true,
      execution_mode: executionMode,
      user_id: roleGate.userId,
      timestamp: transitionAt,
    },
  });

  try {
    await notifyCommunityAi({
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      action_id: actionId,
      event_type: 'approved',
      message: `Action approved for ${action.platform}`,
    });
  } catch (notifyErr: any) {
    console.warn('[community-ai/execute] notify failed:', notifyErr?.message || notifyErr);
  }

  // The executor now owns the terminal row write (persist:true). It stamps
  // status, execution_mode, execution_result, idempotency_key, the
  // correlation id, and clears lease fields on terminal transitions.
  const result = await executeAction(
    {
      id: action.id,
      tenant_id: action.tenant_id,
      organization_id: action.organization_id,
      platform: action.platform,
      action_type: action.action_type as 'like' | 'reply' | 'schedule' | 'follow' | 'share',
      target_id: action.target_id,
      suggested_text: finalText,
      playbook_id: action.playbook_id,
      requires_approval: action.requires_approval,
      requires_human_approval: action.requires_human_approval,
      risk_level: action.risk_level as 'high' | 'medium' | 'low',
      execution_mode: executionMode as any,
      tone_used: action.tone_used,
      approved_at: approvedAtIso,
      // Carried through so the executor builds the new-DM step for the right sender (review B1, 2026-11-22).
      acting_user_id: (action as any).acting_user_id ?? null,
      dm_lead_id: (action as any).dm_lead_id ?? null,
      dm_sender_member_id: (action as any).dm_sender_member_id ?? null,
    },
    body.approved === true,
    {
      source: 'manual',
      persist: true,
      // A new DM gets its own key: the automatic key buckets by target + 5 minutes, so two colleagues' messages to
      // the same lead would otherwise collide and the second would be reported with the first one's outcome.
      idempotency_key: isLinkedInNewDm ? `newdm:${action.id}` : (idempotencyKey ?? undefined),
      final_text: finalText,
    }
  );

  let nextStatus = result.status === 'dispatched' ? 'pending' : result.status;

  // Review B1 (2026-11-22): a run that came back 'blocked' (plan limit - nothing was sent) must end 'blocked', never stay
  // 'executing' and never be reported as another row's outcome. If the executor's own write did not land on THIS row
  // (write error, or an idempotency collision answered with a different row), write 'blocked' here - only from
  // 'executing', only on this row.
  const ranBlocked = result.status === 'blocked' || (result.response as any)?.original_status === 'blocked';
  const ownWriteMissing = Boolean(result.response?.persist_error)
    || (Boolean((result as any).deduplicated) && (result as any).prior_action_id !== actionId);
  if (ranBlocked && ownWriteMissing) {
    // The executor's own reason (e.g. PLAN_LIMIT_EXCEEDED), not the write error that replaced it.
    const originalError = (result.response as any)?.original_error ?? result.error;
    const blockedResult = { ...result, ok: false, status: 'blocked', error: originalError, deduplicated: undefined, prior_action_id: undefined };
    const { data: compensated } = await supabase
      .from('community_ai_actions')
      .update({ status: 'blocked', execution_result: blockedResult, updated_at: new Date().toISOString() })
      .eq('id', actionId)
      .eq('status', 'executing')
      .select('id')
      .maybeSingle();
    if (!compensated) {
      return res.status(500).json({ error: 'TERMINAL_WRITE_FAILED', execution: result });
    }
    return res.status(400).json({
      tenant_id: scope.tenantId, organization_id: scope.organizationId, action_id: actionId,
      status: 'blocked', execution: blockedResult, error: 'ACTION_BLOCKED', blocked_reason: blockedReasonCode(blockedResult),
    });
  }

  if (result.response?.persist_error) {
    return res.status(500).json({ error: 'TERMINAL_WRITE_FAILED', execution: result });
  }

  // Skip the outcome event for in-flight browser dispatches — the extension's
  // /action-result writes the real terminal event once the command lands.
  // A 'blocked' result (plan-limit restriction) is not logged as 'failed' (owner 2026-11-22): the action row records
  // status 'blocked' with its reason.
  if (result.status !== 'dispatched' && result.status !== 'blocked') {
    await logCommunityAiActionEvent({
      action_id: actionId,
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      event_type:
        result.status === 'executed' || result.status === 'sent_unverified'
          ? 'executed'
          : 'failed',
      event_payload: {
        ...result,
        execution_mode: result.execution_mode || executionMode,
        final_text: finalText,
        playbook_id: action.playbook_id ?? null,
        intent: action.intent_classification ?? null,
        user_id: roleGate.userId,
        timestamp: new Date().toISOString(),
      },
    });
  }

  if (!result.ok && result.status !== 'blocked') {
    const { data: failureLogs } = await supabase
      .from('community_ai_action_logs')
      .select('id')
      .eq('action_id', actionId)
      .eq('event_type', 'failed')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if (failureLogs && failureLogs.length >= 3) {
      try {
        await sendCommunityAiWebhooks({
          tenant_id: scope.tenantId,
          organization_id: scope.organizationId,
          event_type: 'failed',
          action_id: actionId,
          message: 'Repeated action failures detected',
          metadata: { failure_count: failureLogs.length },
        });
      } catch (webhookErr: any) {
        console.warn('[community-ai/execute] failure webhook failed:', webhookErr?.message || webhookErr);
      }
    }
  }

  const httpStatus = result.ok ? 200 : 400;
  return res.status(httpStatus).json({
    tenant_id: scope.tenantId,
    organization_id: scope.organizationId,
    action_id: actionId,
    status: nextStatus,
    execution: result,
    // A plan-limit restriction is reported as such, never as "execution failed".
    ...(nextStatus === 'blocked' ? { error: 'ACTION_BLOCKED', blocked_reason: blockedReasonCode(result) } : {}),
  });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/community-ai/actions/execute' });
