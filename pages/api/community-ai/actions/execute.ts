import { createApiRoute as __createApiRoute } from '../../../../lib/platform/routeFactory';
import type { NextApiRequest, NextApiResponse } from 'next';
import { supabase } from '../../../../backend/db/supabaseClient';
import { getCommunityAiActionById } from '../../../../backend/db/communityAiActionStore';
import { enforceActionRole, requireTenantScope } from '../utils';
import { COMMUNITY_AI_CAPABILITIES } from '../../../../backend/services/rbac/communityAiCapabilities';
import { executeAction, loadHistoryMetrics } from '../../../../backend/services/communityAiActionExecutor';
import { logCommunityAiActionEvent } from '../../../../backend/services/communityAiActionLogService';
import { notifyCommunityAi } from '../../../../backend/services/communityAiNotificationService';
import { sendCommunityAiWebhooks } from '../../../../backend/services/communityAiWebhookService';
import { getPlaybookById } from '../../../../backend/services/playbooks/playbookService';
import {
  checkCommunityActionContactGovernance,
  contactGateAuditPayload,
} from '../../../../backend/services/communityAiContactGovernanceGate';
import {
  validateActionAgainstPlaybook,
} from '../../../../backend/services/playbooks/playbookValidator';
import {
  parseExecutionMode,
  EXECUTION_MODES,
  RPA_QUEUED_FOR_WORKER,
  type KnownExecutionMode,
} from '../../../../backend/services/communityAiExecutionModes';

type ExecuteRequest = {
  tenant_id?: string;
  organization_id?: string;
  action_id?: string;
  approved?: boolean;
  /** Closed enum (communityAiExecutionModes.EXECUTION_MODES); anything else is a 400. */
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
  // Phase C: the requested mode is a closed enum, refused before any read.
  const bodyMode = parseExecutionMode(body.execution_mode);
  if (bodyMode.kind === 'invalid') {
    return res.status(400).json({ error: 'EXECUTION_MODE_INVALID', allowed: EXECUTION_MODES });
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

  // Round 24D / G-7 — contact governance on the row of record, BEFORE the
  // state transition. The executor checks again (defense in depth), but it is
  // handed the row without its metadata, so the DM thread identifiers are
  // checked here. Refusal leaves the row in its current state: no transition,
  // no execution, no suppression lifted or recorded.
  const contactGate = await checkCommunityActionContactGovernance({
    id: actionId,
    organization_id: action.organization_id,
    platform: action.platform,
    action_type: action.action_type,
    target_id: action.target_id,
    metadata: (action as any).metadata ?? null,
  });
  if (contactGate.allowed === false) {
    await logCommunityAiActionEvent({
      action_id: actionId,
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      event_type: 'skipped',
      event_payload: contactGateAuditPayload(contactGate, { boundary: 'execute', user_id: roleGate.userId }),
    });
    // Round 26: an unidentifiable recipient/author is refused like a suppressed one (403, not retryable).
    if (contactGate.code === 'CONTACT_IDENTITY_UNRESOLVED') {
      return res.status(403).json({ error: 'CONTACT_IDENTITY_UNRESOLVED', reason: contactGate.reason });
    }
    return contactGate.code === 'CONTACT_SUPPRESSED'
      ? res.status(403).json({ error: 'CONTACT_SUPPRESSED', reason: contactGate.reason })
      : res.status(503).json({ error: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: contactGate.reason });
  }

  // Manual is the human-driven simulation path; everything else is delegated
  // to the central router inside the executor (which itself handles fallback).
  // A stored mode outside the enum is refused like a requested one (fail closed).
  const requestedMode = bodyMode.kind === 'absent' ? parseExecutionMode(action.execution_mode) : bodyMode;
  if (requestedMode.kind === 'invalid') {
    return res.status(400).json({ error: 'EXECUTION_MODE_INVALID', allowed: EXECUTION_MODES });
  }
  const executionMode: KnownExecutionMode = requestedMode.kind === 'known' ? requestedMode.mode : 'manual';

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
  // Phase C: the playbook's rate limits are checked against real history (was
  // null, so limits never applied on this route).
  const historyMetrics = playbook && action.playbook_id
    ? await loadHistoryMetrics(scope.tenantId, scope.organizationId, action.playbook_id)
    : null;
  const validation = validateActionAgainstPlaybook(
    {
      action_type: action.action_type as 'like' | 'reply' | 'schedule' | 'follow' | 'share',
      text: finalText,
      execution_mode: executionMode,
      risk_level: action.risk_level as 'high' | 'medium' | 'low',
    },
    playbook,
    historyMetrics
  );
  if (!validation.allowed) {
    return res.status(400).json({
      error: 'PLAYBOOK_VIOLATION',
      reason: validation.reason || 'Playbook validation failed.',
    });
  }
  // Approval of record (approved_at, set only by /api/community-ai/actions/approve)
  // is required before anything executes when:
  //   - the playbook says a human must approve this action (Phase C); the
  //     body's approved:true is the caller's click, not that record;
  //   - S-2: the mode is rpa. An rpa run is executed by the browser worker,
  //     whose gate (checkRpaRetryAuthorised) refuses a row without approved_at;
  //     answering 202 "queued" for work the worker will refuse would be a lie.
  // B-2: the refusal must not be a dead end. approve.ts acts only on a row that
  // is 'pending' AND requires_human_approval = true, so the refusal records
  // exactly that (tenant-scoped, only while the row is still executable and
  // unapproved). status becomes 'pending' because the DB CHECK
  // community_ai_actions_approval_integrity_check admits requires_human_approval
  // without approved_at only for 'pending' / 'skipped'; a 'scheduled' row
  // therefore becomes 'pending' and is executed by the user after approval.
  // Nothing executes, nothing transitions to 'executing', no executor call.
  const approvalReason = validation.requires_approval === true && !action.approved_at
    ? 'PLAYBOOK_REQUIRES_APPROVAL'
    : executionMode === 'rpa' && !action.approved_at
      ? 'RPA_REQUIRES_APPROVAL_OF_RECORD'
      : null;
  if (approvalReason) {
    const { data: marked, error: markError } = await supabase
      .from('community_ai_actions')
      .update({ requires_human_approval: true, status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', actionId)
      .eq('tenant_id', scope.tenantId)
      .eq('organization_id', scope.organizationId)
      .in('status', Array.from(EXECUTABLE_FROM_STATUSES))
      .is('approved_at', null)
      .select('id, status, requires_human_approval')
      .maybeSingle();
    if (markError) {
      // Nothing executed and nothing recorded: an honest retry.
      console.error('[community-ai/execute] approval-required state write failed:', markError.message);
      return res.status(503).json({ error: 'APPROVAL_STATE_WRITE_FAILED', reason: approvalReason, retryable: true });
    }
    if (!marked) {
      // The row changed under us (approved, executed or moved on): re-read and retry.
      return res.status(409).json({ error: 'ACTION_STATE_CHANGED', reason: approvalReason });
    }
    return res.status(403).json({
      error: 'APPROVAL_REQUIRED',
      reason: approvalReason,
      approval_required: true,
      action_id: actionId,
      status: marked.status,
      requires_human_approval: true,
      next_step: 'approve',
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
  if (idempotencyKey) transitionPayload.idempotency_key = idempotencyKey;

  // Review SF-1: a row another executor holds under a live dispatch lease (the
  // scheduler's claim, or the extension's) is not taken here: 0 rows -> 409.
  // Same expiry rule as /api/extension/commands; an expired lease is free.
  const { data: claimed, error: claimError } = await supabase
    .from('community_ai_actions')
    .update(transitionPayload)
    .eq('id', actionId)
    .in('status', Array.from(EXECUTABLE_FROM_STATUSES))
    .or(`dispatch_lease_expires_at.is.null,dispatch_lease_expires_at.lt.${transitionAt}`)
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
    },
    body.approved === true,
    {
      source: 'manual',
      persist: true,
      idempotency_key: idempotencyKey ?? undefined,
      final_text: finalText,
    }
  );

  const nextStatus = result.status === 'dispatched' ? 'pending' : result.status;

  if (result.response?.persist_error) {
    return res.status(500).json({ error: 'TERMINAL_WRITE_FAILED', execution: result });
  }

  // Phase C: an rpa run on a non-worker runtime is durably queued for the
  // browser worker and NOT attempted here: 202, not a failure. No 'failed' outcome event
  // and no repeated-failure webhook: nothing failed (the executor persisted
  // the row with execution_result.error = RPA_QUEUED_FOR_WORKER).
  if (!result.ok && result.error === RPA_QUEUED_FOR_WORKER) {
    return res.status(202).json({
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      action_id: actionId,
      status: 'queued',
      queued_for_worker: true,
      execution: result,
    });
  }

  // Skip the outcome event for in-flight browser dispatches — the extension's
  // /action-result writes the real terminal event once the command lands.
  if (result.status !== 'dispatched') {
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

  if (!result.ok) {
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
  });
}

// W0-1 (Gate A): canonical route pipeline — pass-through observability + request context.
export default __createApiRoute(handler, { route: '/api/community-ai/actions/execute' });
