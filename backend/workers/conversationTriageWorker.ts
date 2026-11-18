/**
 * Conversation Triage Worker
 * Scans threads with new messages, classifies unclassified or stale threads.
 * Runs every 3 minutes.
 *
 * Correctness (c6, 2026-11-18; F2 findings a/c/d - independent of the pending pricing decision):
 *   - F2a SELECTION: the scan used to read 100 threads with no ORDER and no "needs classification" filter, so the same
 *     arbitrary 100 were scanned every tick and threads outside them could never be reached. It now pages through
 *     threads newest-activity first (updated_at desc, id as the stable tiebreak), up to MAX_PAGES, and caps each
 *     company's share of a tick (PER_ORG_CAP) so one busy company cannot starve the others.
 *   - F2d READS FAIL CLOSED: a failed read of the latest messages or of the existing classifications used to look like
 *     "no messages / never classified", which re-classified (and paid for) every thread on the page. Any read error now
 *     ends the tick with no AI call.
 *   - F2c ONE AI CALL PER THREAD PER TICK: classification used to run INSIDE executeWithRetry, so a null result or a
 *     failed DB write re-ran the provider call up to 3 times. The thread is now classified ONCE; a null result is final
 *     for this tick (the next tick retries naturally); only the idempotent DB write is retried.
 */

import { supabase } from '../db/supabaseClient';
import { classifyThread } from '../services/conversationTriageService';
import { recordMetric } from '../services/systemHealthMetricsService';
import { executeWithRetry } from '../services/workerRetryService';
import { getControls } from '../services/engagementGovernanceService';
import { executeWithCredits, makeIdempotencyKey } from '../services/creditExecutionService';

/**
 * OWNER 2026-11-18: triage is billed at a FIXED 1 credit per classified conversation, and is OPT-IN
 * (engagement_system_controls.triage_engine_enabled, default false). Billing runs through executeWithCredits, which owns
 * the hold lifecycle: the EXECUTOR classifies AND writes the classification, so the credit is confirmed only when a
 * classification was actually stored - a null result or a failed write throws inside the executor and the hold is
 * released (nothing charged). The idempotency key is per ATTEMPT (thread + tick), so a released attempt never blocks
 * the next tick's retry; a stored classification takes the thread out of selection, so a success is not re-charged.
 * A refused hold (no credits / no account / org control) skips that company for the rest of the tick - no retry.
 */
export const TRIAGE_CREDITS_PER_CONVERSATION = 1;
const TRIAGE_ACTION = 'conversation_triage' as const;

export const TRIAGE_BATCH_LIMIT = 15;
export const TRIAGE_PAGE_SIZE = 100;
export const TRIAGE_MAX_PAGES = 5;
export const TRIAGE_PER_ORG_CAP = 5;

type Candidate = { threadId: string; organizationId: string };

/** Pick up to TRIAGE_BATCH_LIMIT threads needing classification; null = a read failed (fail closed). */
async function selectCandidates(): Promise<Candidate[] | null> {
  const picked: Candidate[] = [];
  const perOrg = new Map<string, number>();
  // 7c residual: OFFSET paging over a MUTABLE key (updated_at) - concurrent inbound activity can move a thread so it is
  // served on two pages in one tick. A thread is picked at most once per tick (no double classification / double pay).
  // The structural fix (one bounded query for unclassified-or-stale threads via an RPC/view) is a register item.
  const seen = new Set<string>();

  for (let page = 0; page < TRIAGE_MAX_PAGES && picked.length < TRIAGE_BATCH_LIMIT; page++) {
    const from = page * TRIAGE_PAGE_SIZE;
    const { data: threads, error: threadsErr } = await supabase
      .from('engagement_threads')
      .select('id, organization_id')
      .not('organization_id', 'is', null)
      .eq('ignored', false)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, from + TRIAGE_PAGE_SIZE - 1);
    if (threadsErr) return null;
    if (!threads?.length) break;

    const threadIds = threads.map((t: { id: string }) => t.id);

    const { data: latestMsgs, error: msgsErr } = await supabase
      .from('engagement_messages')
      .select('thread_id, platform_created_at')
      .in('thread_id', threadIds)
      .order('platform_created_at', { ascending: false });
    if (msgsErr) return null;

    const latestByThread = new Map<string, string>();
    for (const m of latestMsgs ?? []) {
      const t = m as { thread_id: string; platform_created_at: string };
      if (!latestByThread.has(t.thread_id)) latestByThread.set(t.thread_id, t.platform_created_at ?? '');
    }

    const { data: classifications, error: classErr } = await supabase
      .from('engagement_thread_classification')
      .select('thread_id, classified_at')
      .in('thread_id', threadIds);
    if (classErr) return null;
    const classifiedAt = new Map<string, string | undefined>();
    for (const c of classifications ?? []) {
      const r = c as { thread_id: string; classified_at?: string };
      classifiedAt.set(r.thread_id, r.classified_at);
    }

    for (const t of threads) {
      const th = t as { id: string; organization_id: string };
      if (seen.has(th.id)) continue;
      seen.add(th.id);
      const latestMsgTime = latestByThread.get(th.id) ?? '';
      const needs = !classifiedAt.has(th.id)
        || Boolean(latestMsgTime && classifiedAt.get(th.id) && latestMsgTime > (classifiedAt.get(th.id) as string));
      if (!needs) continue;
      const n = perOrg.get(th.organization_id) ?? 0;
      if (n >= TRIAGE_PER_ORG_CAP) continue;
      perOrg.set(th.organization_id, n + 1);
      picked.push({ threadId: th.id, organizationId: th.organization_id });
      if (picked.length >= TRIAGE_BATCH_LIMIT) break;
    }
    if (threads.length < TRIAGE_PAGE_SIZE) break;
  }
  return picked;
}

async function writeClassification(threadId: string, organizationId: string, result: NonNullable<Awaited<ReturnType<typeof classifyThread>>>): Promise<void> {
  const { data: existing, error: readErr } = await supabase
    .from('engagement_thread_classification')
    .select('id')
    .eq('thread_id', threadId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  const row = {
    organization_id: organizationId,
    thread_id: threadId,
    classification_category: result.classification_category,
    classification_confidence: result.classification_confidence,
    sentiment: result.sentiment,
    triage_priority: result.triage_priority,
    classified_at: new Date().toISOString(),
  };

  if (existing) {
    const { error: updateErr } = await supabase
      .from('engagement_thread_classification')
      .update(row)
      .eq('thread_id', threadId)
      .eq('organization_id', organizationId);
    if (updateErr) throw new Error(updateErr.message);
  } else {
    const { error: insertErr } = await supabase.from('engagement_thread_classification').insert(row);
    if (insertErr) throw new Error(insertErr.message);
  }
}

export async function runConversationTriageWorker(): Promise<{
  processed: number;
  errors: number;
}> {
  const startMs = Date.now();
  let processed = 0;
  let errors = 0;

  const candidates = await selectCandidates();
  if (candidates === null) {
    console.error('[conversationTriage] triage_selection_read_failed - tick skipped, no AI call');
    void recordMetric('conversation_triage_worker', 'errors', 1, 'jobs').catch(() => {});
    return { processed: 0, errors: 1 };
  }

  const tick = String(startMs);
  const refusedOrgs = new Set<string>();
  for (const { threadId, organizationId } of candidates) {
    if (refusedOrgs.has(organizationId)) continue;
    const controls = await getControls(organizationId);
    if (!controls.triage_engine_enabled) continue;   // OPT-IN: off unless the company turned it on

    try {
      const outcome = await executeWithCredits({
        userId: organizationId,
        orgId: organizationId,
        action: TRIAGE_ACTION,
        referenceType: TRIAGE_ACTION,
        referenceId: threadId,
        idempotencyKey: makeIdempotencyKey(organizationId, TRIAGE_ACTION, threadId, `tick:${tick}`),
        amountOverride: TRIAGE_CREDITS_PER_CONVERSATION,
        validateMembership: false,   // system-initiated (the company opted in)
        note: 'Conversation triage',
        executor: async () => {
          // ONE provider call per thread per tick (F2c); a null result throws -> hold released, nothing charged.
          const result = await classifyThread(threadId, organizationId);
          if (!result) throw new Error('TRIAGE_NO_RESULT');
          // Only the idempotent DB write is retried - never the AI call. A failed write throws -> released.
          await executeWithRetry('conversationTriageWorker', { threadId, organizationId },
            () => writeClassification(threadId, organizationId, result));
          return true;
        },
      });
      if (outcome.status === 'executed') {
        processed++;
      } else if (outcome.status === 'insufficient_credits' || outcome.status === 'no_credit_account'
        || outcome.status === 'org_control_blocked' || outcome.status === 'not_a_member') {
        refusedOrgs.add(organizationId);   // skip this company for the rest of the tick; no retry storm
      }
    } catch {
      errors++;   // executor threw (null result / failed write) - the hold was released by executeWithCredits
    }
  }

  void recordMetric('conversation_triage_worker', 'processed', processed, 'jobs').catch(() => {});
  void recordMetric('conversation_triage_worker', 'errors', errors, 'jobs').catch(() => {});
  void recordMetric('conversation_triage_worker', 'duration_ms', Date.now() - startMs, 'ms').catch(() => {});

  return { processed, errors };
}
