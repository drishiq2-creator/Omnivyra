/**
 * Outreach approval queue - READ (a9, 2026-11-20; slice 2 of the email operator work; Audit §2 "Outbound approval":
 * "No tenant approval route or queue").
 *
 * The tasks of ONE company that need a human decision before anything is sent:
 *   - 'awaiting_approval'                      submitted, waiting for a decision;
 *   - 'pending' with requires_approval = true  materialised, not yet submitted (the approve route submits then decides).
 * Ordered oldest first, capped at `limit` (truncated is reported, never hidden).
 *
 * THE DATABASE FILTERS, NOT JS (7c review of 07fdab4ef). An earlier form read both statuses oldest-first with a 4x cap
 * and filtered in JS: a company with many older 'pending' rows that need no approval filled the window, and the queue
 * answered empty + truncated FOREVER while real tasks waited (the window never advances). The decision predicate is
 * now an `.or()` so `limit` is exact and `truncated` precise. TRADE-OFF CHOSEN: an `.or()` string is where a tenant
 * filter gets swallowed if someone moves `company_id` inside it - so the company filter is a SEPARATE top-level
 * `.eq()` (PostgREST ANDs top-level filters) and a test pins that the `.or()` string never mentions company_id.
 * The JS predicate below is kept as a fail-closed second check (NULL requires_approval is never listed).
 *
 * A FAILED read is never an empty queue (b3 read-failure rule): it returns { ok: false, code } and the route answers
 * 503. The caller names the company; authorization is the ROUTE's job (requireTenantAccess) - this function trusts
 * only the companyId it is given and filters every row by it.
 */
import { ownedDbTable } from '../../db/writeOwner';

export type ApprovalQueueStage = 'awaiting_approval' | 'not_submitted';

export interface ApprovalQueueItem {
  taskId: string;
  leadId: string;
  stage: ApprovalQueueStage;
  channel: string | null;
  kind: string | null;
  action: string | null;
  explanation: string | null;
  createdAt: string;
}

export type ApprovalQueueResult =
  | { ok: true; items: ApprovalQueueItem[]; truncated: boolean }
  | { ok: false; code: 'OUTREACH_TASKS_UNREADABLE'; message: string };

export const APPROVAL_QUEUE_DEFAULT_LIMIT = 50;
export const APPROVAL_QUEUE_MAX_LIMIT = 200;
/** The decision predicate. MUST NOT mention company_id - tenant scope is the separate .eq() (pinned by a test). */
export const APPROVAL_QUEUE_DECISION_FILTER = 'status.eq.awaiting_approval,and(status.eq.pending,requires_approval.eq.true)';

type Row = {
  id: string; lead_id: string; status: string; requires_approval: boolean;
  channel: string | null; kind: string | null; action: string | null; explanation: string | null; created_at: string;
};

export async function listTasksAwaitingApproval(companyId: string, opts: { limit?: number } = {}): Promise<ApprovalQueueResult> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? APPROVAL_QUEUE_DEFAULT_LIMIT)), APPROVAL_QUEUE_MAX_LIMIT);
  let rows: Row[];
  try {
    const { data, error } = await ownedDbTable('outreach_tasks')
      .select('id, lead_id, status, requires_approval, channel, kind, action, explanation, created_at')
      .eq('company_id', companyId)
      .or(APPROVAL_QUEUE_DECISION_FILTER)
      .order('created_at', { ascending: true })
      .limit(limit + 1);
    if (error) return { ok: false, code: 'OUTREACH_TASKS_UNREADABLE', message: String(error.message ?? 'read error') };
    rows = (data ?? []) as Row[];
  } catch (e) {
    return { ok: false, code: 'OUTREACH_TASKS_UNREADABLE', message: e instanceof Error ? e.message : String(e) };
  }
  // Fail-closed second check: the database already filtered; a row that is not a decision row is never listed.
  const waiting = rows.filter((r) => r.status === 'awaiting_approval' || (r.status === 'pending' && r.requires_approval === true));
  const items = waiting.slice(0, limit).map((r): ApprovalQueueItem => ({
    taskId: r.id,
    leadId: r.lead_id,
    stage: r.status === 'awaiting_approval' ? 'awaiting_approval' : 'not_submitted',
    channel: r.channel ?? null,
    kind: r.kind ?? null,
    action: r.action ?? null,
    explanation: r.explanation ?? null,
    createdAt: r.created_at,
  }));
  // The read asks for limit + 1 decision rows: one more than shown means more exist.
  const truncated = rows.length > limit;
  return { ok: true, items, truncated };
}
