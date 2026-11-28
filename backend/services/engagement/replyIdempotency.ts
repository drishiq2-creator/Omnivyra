/**
 * E3 (register row T-2) — stable logical-reply identity for
 * POST /api/engagement/reply.
 *
 * WHY THE ROUTE CLAIMS THE KEY ITSELF
 *   The executor stamps `idempotency_key` only in persistExecutionResult, i.e.
 *   AFTER the provider call. Its unique-index "dedup" therefore only tells a
 *   second request that it has ALREADY sent twice. The route instead inserts
 *   the community_ai_actions row WITH the key before executeAction runs (the
 *   executor's auto_insert then finds the row by id and inserts nothing), so
 *   Production's UNIQUE (organization_id, idempotency_key) index decides —
 *   before any send — which of two concurrent requests owns the reply.
 *
 * KEY FORMULA
 *   engagement-reply:v1:<sha256(JSON[organization_id, target_ref, platform,
 *   action_type, client_key | "server-derived", sha256(normalised text)])>
 *   - organization_id is the authorized company the route resolved and
 *     enforced (never re-read from the body after access control);
 *   - target_ref is the server-resolved engagement message (`message:<id>`) or
 *     campaign signal (`signal:<id>`) — stable across retries, unlike the
 *     platform dispatch target (LinkedIn DM target lookup can change);
 *   - the normalised text IS part of the identity: an edited reply is a new
 *     logical reply (the composer also rotates its key on edit); a
 *     whitespace-only difference is the same reply. Hashing the text also
 *     means a client that reuses one key for different text never gets the
 *     OTHER text's action back as "already sent".
 *   - a missing client key derives a server key from the same values (the
 *     "server-derived" slot). This is not weaker dedup: identical text to the
 *     same target collapses to one send. Its only cost is that a deliberate
 *     identical second reply to the same message is answered "already sent".
 *     It is used because hooks/useReply.ts, pages/engagement-inbox.tsx and
 *     pages/whatsapp/inbox.tsx (outside this change's ownership) do not send a
 *     key yet. A PRESENT but malformed key is refused 400.
 */

import { createHash } from 'crypto';

import { ownedDbTable } from '../../db/writeOwner';
import { LOST_RESPONSE_SKIP_REASONS } from '../communityAiPersistedStatus';

export const CLIENT_REPLY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const ENGAGEMENT_REPLY_KEY_PREFIX = 'engagement-reply:v1:';

export type ClientReplyKeyParse =
  | { ok: true; key: string | null }
  | { ok: false; reason: 'INVALID_CLIENT_REPLY_KEY' };

export function parseClientReplyKey(raw: unknown): ClientReplyKeyParse {
  if (raw === undefined || raw === null) return { ok: true, key: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'INVALID_CLIENT_REPLY_KEY' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, key: null };
  if (!CLIENT_REPLY_KEY_PATTERN.test(trimmed)) return { ok: false, reason: 'INVALID_CLIENT_REPLY_KEY' };
  return { ok: true, key: trimmed };
}

/** Whitespace runs collapse, ends trim; case and characters are kept (they are visible in the reply). */
export function normalizeReplyTextForKey(text: string): string {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function deriveEngagementReplyIdempotencyKey(input: {
  organizationId: string;
  targetRef: string;
  platform: string;
  actionType: 'reply' | 'dm';
  clientKey: string | null;
  replyText: string;
}): string {
  const basis = JSON.stringify([
    input.organizationId,
    input.targetRef,
    input.platform,
    input.actionType,
    input.clientKey ?? 'server-derived',
    sha256(normalizeReplyTextForKey(input.replyText)),
  ]);
  return ENGAGEMENT_REPLY_KEY_PREFIX + sha256(basis);
}

export type ExistingReplyAction = {
  id: string;
  organization_id?: string | null;
  status?: string | null;
  skip_reason?: string | null;
  execution_mode?: string | null;
  execution_result?: Record<string, unknown> | null;
};

/**
 * How a stored attempt of this logical reply must be answered:
 *   executed        — the platform confirmed: answer "already sent", never resend;
 *   queued          — a browser-mode row still waiting for the extension: answer queued (same action id);
 *   in_progress     — another request owns it right now, OR it crashed / lost its
 *                     persist mid-send: outcome unknown, never resend;
 *   outcome_unknown — sent_unverified / OUTCOME_UNKNOWN / anything unrecognised: never resend;
 *   failed_ambiguous— a failure that may have reached the platform (extension- or
 *                     reaper-reported): never resend under this key;
 *   not_sent        — a failure CONFIRMED to have happened before any provider
 *                     call: the same key may re-execute (on the same row, CAS-claimed).
 */
export type ExistingReplyDisposition =
  | 'executed'
  | 'queued'
  | 'in_progress'
  | 'outcome_unknown'
  | 'failed_ambiguous'
  | 'not_sent';

/** Executor gates that return before any provider call (runExecution order). Persisted as skipped + skip_reason. */
const PRE_SEND_SKIP_REASONS: ReadonlySet<string> = new Set([
  'PLATFORM_POLICY',
  'HUMAN_APPROVAL_REQUIRED',
  'CONTACT_SUPPRESSED',
  'CONTACT_IDENTITY_UNRESOLVED',
  'CONTACT_GOVERNANCE_UNAVAILABLE',
  'PLAN_LIMIT_EXCEEDED',
]);

/** validateAction / requiresApproval / playbook gates — persisted as failed with this error and NO execution mode. */
const PRE_SEND_FAILED_ERRORS: ReadonlySet<string> = new Set([
  'TENANT_ID_REQUIRED',
  'ORGANIZATION_ID_REQUIRED',
  'PLATFORM_REQUIRED',
  'ACTION_TYPE_INVALID',
  'TARGET_ID_REQUIRED',
  'SUGGESTED_TEXT_REQUIRED',
  'APPROVAL_REQUIRED',
  'PLAYBOOK_NOT_FOUND',
  'PLAYBOOK_REQUIRED',
]);

const resultField = (row: ExistingReplyAction, field: string): unknown =>
  row.execution_result && typeof row.execution_result === 'object' ? (row.execution_result as Record<string, unknown>)[field] : undefined;

export function classifyExistingReplyAction(row: ExistingReplyAction): ExistingReplyDisposition {
  const status = String(row.status ?? '');
  const resultMode = resultField(row, 'execution_mode');
  const noModeReached = resultMode === undefined || resultMode === null || resultMode === '';
  switch (status) {
    case 'executed':
      return 'executed';
    case 'pending':
    case 'approved': {
      const isBrowser = row.execution_mode === 'browser';
      const dispatched = resultField(row, 'status') === 'dispatched';
      return isBrowser && dispatched ? 'queued' : 'in_progress';
    }
    case 'skipped': {
      const reason = String(row.skip_reason ?? '');
      if (LOST_RESPONSE_SKIP_REASONS.has(reason)) return 'outcome_unknown';
      if (PRE_SEND_SKIP_REASONS.has(reason) && noModeReached) return 'not_sent';
      return 'outcome_unknown';
    }
    case 'failed': {
      // cancel-queued only fails a pending row with NO dispatch lease: the extension never claimed it.
      if (resultField(row, 'source') === 'user' && resultField(row, 'reason') === 'user_cancelled') return 'not_sent';
      const error = resultField(row, 'error');
      if (typeof error === 'string' && PRE_SEND_FAILED_ERRORS.has(error) && noModeReached) return 'not_sent';
      return 'failed_ambiguous';
    }
    default:
      return 'outcome_unknown';
  }
}

const EXISTING_COLUMNS = 'id, organization_id, status, skip_reason, execution_mode, execution_result';

export type LookupOutcome =
  | { ok: true; row: ExistingReplyAction | null }
  | { ok: false; error: string };

/** Tenant-scoped read: a row of another organization is never returned, whatever its key. */
export async function findReplyActionByKey(organizationId: string, idempotencyKey: string): Promise<LookupOutcome> {
  const { data, error } = await ownedDbTable('community_ai_actions')
    .select(EXISTING_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) return { ok: false, error: String((error as { message?: unknown }).message ?? error) };
  const row = (data ?? null) as ExistingReplyAction | null;
  if (row && row.organization_id && row.organization_id !== organizationId) return { ok: true, row: null };
  return { ok: true, row };
}

export type ClaimOutcome =
  | { kind: 'claimed'; actionId: string }
  | { kind: 'lost'; existing: ExistingReplyAction | null }
  | { kind: 'error'; error: string };

const isUniqueViolation = (error: unknown): boolean =>
  String((error as { code?: unknown } | null)?.code ?? '') === '23505';

/**
 * Insert the pending row WITH the key before any send. The field set mirrors
 * the executor's auto_insert (communityAiActionExecutorRuntime.ts) so nothing
 * downstream sees a different row than before: same status, same human
 * approval stamp (source 'manual' is human-initiated), same correlation id.
 * 23505 = another request owns this logical reply: re-read and return it.
 */
export async function claimReplyAction(input: {
  actionId: string;
  idempotencyKey: string;
  correlationId: string;
  row: {
    organization_id: string;
    tenant_id: string;
    platform: string;
    action_type: string;
    target_id: string;
    suggested_text: string;
    execution_mode: string | null;
    acting_user_id: string | null;
  };
}): Promise<ClaimOutcome> {
  const now = new Date().toISOString();
  const { error } = await ownedDbTable('community_ai_actions').insert({
    id: input.actionId,
    tenant_id: input.row.tenant_id,
    organization_id: input.row.organization_id,
    platform: input.row.platform,
    action_type: input.row.action_type,
    target_id: input.row.target_id,
    suggested_text: input.row.suggested_text,
    risk_level: 'low',
    requires_human_approval: false,
    requires_approval: null,
    execution_mode: input.row.execution_mode,
    playbook_id: null,
    tone_used: null,
    acting_user_id: input.row.acting_user_id,
    status: 'pending',
    idempotency_key: input.idempotencyKey,
    execution_correlation_id: input.correlationId,
    approved_at: now,
    created_at: now,
    updated_at: now,
  });
  if (!error) return { kind: 'claimed', actionId: input.actionId };
  if (!isUniqueViolation(error)) return { kind: 'error', error: String((error as { message?: unknown }).message ?? error) };
  const winner = await findReplyActionByKey(input.row.organization_id, input.idempotencyKey);
  if (winner.ok === false) return { kind: 'error', error: winner.error };
  return { kind: 'lost', existing: winner.row };
}

/**
 * Re-claim a CONFIRMED-NOT-SENT attempt for one re-execution under the same
 * key. Compare-and-set on the stored status (+ skip_reason): of two concurrent
 * retries exactly one moves the row back to pending; the other matches zero
 * rows and answers with the winner's state.
 */
export async function reclaimNotSentReplyAction(organizationId: string, idempotencyKey: string, prior: ExistingReplyAction): Promise<ClaimOutcome> {
  let q = ownedDbTable('community_ai_actions')
    .update({ status: 'pending', skip_reason: null, updated_at: new Date().toISOString() })
    .eq('id', prior.id)
    .eq('organization_id', organizationId)
    .eq('idempotency_key', idempotencyKey)
    .eq('status', String(prior.status ?? ''));
  q = prior.skip_reason == null ? q.is('skip_reason', null) : q.eq('skip_reason', prior.skip_reason);
  const { data, error } = await q.select('id, status').maybeSingle();
  if (error) return { kind: 'error', error: String((error as { message?: unknown }).message ?? error) };
  if (data && (data as { id?: string }).id) return { kind: 'claimed', actionId: String((data as { id: string }).id) };
  const current = await findReplyActionByKey(organizationId, idempotencyKey);
  if (current.ok === false) return { kind: 'error', error: current.error };
  return { kind: 'lost', existing: current.row };
}

export const REPLY_OUTCOME_UNKNOWN_MESSAGE =
  'Sending status unknown — this reply may already have reached the platform. Check the conversation before resending; it was not sent again.';
export const REPLY_IN_PROGRESS_MESSAGE =
  'This reply is already being sent, or its outcome is not yet known. Check the conversation before resending; it was not sent again.';
export const REPLY_PRIOR_FAILED_MESSAGE =
  'An earlier attempt of this exact reply failed and may have reached the platform, so it was not sent again. Check the conversation; to send it anyway, edit the reply first.';
