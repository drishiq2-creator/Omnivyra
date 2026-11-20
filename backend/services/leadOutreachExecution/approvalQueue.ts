/**
 * Outreach approval queue - READ (a9, 2026-11-20; slice 2 of the email operator work; Audit §2 "Outbound approval":
 * "No tenant approval route or queue").
 *
 * The tasks of ONE company that need a human decision before anything is sent:
 *   - 'awaiting_approval'                      submitted, waiting for a decision;
 *   - 'pending' with requires_approval = true  materialised, not yet submitted (the approve route submits then decides).
 * Ordered oldest first, capped at `limit` (truncated is reported, never hidden).
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
      .in('status', ['awaiting_approval', 'pending'])
      .order('created_at', { ascending: true })
      .limit(limit * 4 + 1);
    if (error) return { ok: false, code: 'OUTREACH_TASKS_UNREADABLE', message: String(error.message ?? 'read error') };
    rows = (data ?? []) as Row[];
  } catch (e) {
    return { ok: false, code: 'OUTREACH_TASKS_UNREADABLE', message: e instanceof Error ? e.message : String(e) };
  }
  // 'pending' rows that do NOT require approval are not waiting for anyone; only the two decision stages are listed.
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
  // Truncated when more decision rows exist than shown, OR the read hit its cap (more rows may exist beyond it).
  const truncated = waiting.length > limit || rows.length > limit * 4;
  return { ok: true, items, truncated };
}
