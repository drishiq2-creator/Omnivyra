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

type Candidate = { threadId: string; organizationId: string; classifiedAt: string | null; latestMsgTime: string };

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
      picked.push({ threadId: th.id, organizationId: th.organization_id,
        classifiedAt: classifiedAt.has(th.id) ? (classifiedAt.get(th.id) ?? null) : null, latestMsgTime });
      if (picked.length >= TRIAGE_BATCH_LIMIT) break;
    }
    if (threads.length < TRIAGE_PAGE_SIZE) break;
  }
  return picked;
}

/** Thrown when another worker already wrote this classification (lost CAS / unique violation): the hold is released. */
export class TriageWriteLostRace extends Error {
  constructor(threadId: string) { super(`triage write lost the race for ${threadId}`); this.name = 'TriageWriteLostRace'; }
}

/**
 * Write the classification so that EXACTLY ONE worker wins per selection state - the charge follows the write (7c):
 *   - first classification: INSERT; a concurrent winner makes it fail on the UNIQUE (thread_id, organization_id) index
 *     (20270217000056 asserts that index exists and is valid) -> throw -> the loser's hold is released;
 *   - re-classification: compare-and-swap UPDATE ... WHERE classified_at = <the value selection read>; 0 rows = another
 *     worker already re-classified -> throw -> released.
 * classified_at = the NEWEST MESSAGE TIMESTAMP seen at selection (b3/7c, one clock): the re-classify test is then
 * `latest message > classified_at` on message timestamps only - the app clock never enters it, so clock skew cannot
 * re-select (and re-charge) a thread every tick. A thread with no messages stores now() and is never re-selected
 * (its latest-message time is '' and fails the comparison). classified_at has no other reader.
 */
async function writeClassification(c: Candidate, result: NonNullable<Awaited<ReturnType<typeof classifyThread>>>): Promise<void> {
  const now = new Date().toISOString();
  const row = {
    organization_id: c.organizationId,
    thread_id: c.threadId,
    classification_category: result.classification_category,
    classification_confidence: result.classification_confidence,
    sentiment: result.sentiment,
    triage_priority: result.triage_priority,
    classified_at: c.latestMsgTime || now,
  };

  if (c.classifiedAt === null) {
    const { error: insertErr } = await supabase.from('engagement_thread_classification').insert(row);
    if (insertErr) {
      if ((insertErr as { code?: string }).code === '23505') throw new TriageWriteLostRace(c.threadId);
      throw new Error(insertErr.message);
    }
    return;
  }
  const { data: swapped, error: updateErr } = await supabase
    .from('engagement_thread_classification')
    .update(row)
    .eq('thread_id', c.threadId)
    .eq('organization_id', c.organizationId)
    .eq('classified_at', c.classifiedAt)
    .select('id');
  if (updateErr) throw new Error(updateErr.message);
  if (!Array.isArray(swapped) || swapped.length !== 1) throw new TriageWriteLostRace(c.threadId);
}

export async function runConversationTriageWorker(): Promise<{
  processed: number;
  errors: number;
  /** Companies whose hold was refused this tick (no credits / no account / org control) - visible, not silent (7c). */
  refused: number;
}> {
  const startMs = Date.now();
  let processed = 0;
  let errors = 0;

  const candidates = await selectCandidates();
  if (candidates === null) {
    console.error('[conversationTriage] triage_selection_read_failed - tick skipped, no AI call');
    void recordMetric('conversation_triage_worker', 'errors', 1, 'jobs').catch(() => {});
    return { processed: 0, errors: 1, refused: 0 };
  }

  const tick = String(startMs);
  const refusedOrgs = new Set<string>();
  for (const cand of candidates) {
    const { threadId, organizationId } = cand;
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
          // Only the DB write is retried - never the AI call. A lost race is final (not retried); any failure throws ->
          // the hold is released, nothing charged.
          // A lost race is caught INSIDE the retried function (executeWithRetry would otherwise retry it and dead-letter
          // it) and re-thrown after, so the hold is still released.
          let lostRace = false;
          await executeWithRetry('conversationTriageWorker', { threadId, organizationId }, async () => {
            try { await writeClassification(cand, result); }
            catch (e) { if (e instanceof TriageWriteLostRace) { lostRace = true; return; } throw e; }
          });
          if (lostRace) throw new TriageWriteLostRace(threadId);
          return true;
        },
      });
      if (outcome.status === 'executed') {
        processed++;
      } else if (outcome.status === 'insufficient_credits' || outcome.status === 'no_credit_account'
        || outcome.status === 'org_control_blocked' || outcome.status === 'not_a_member') {
        refusedOrgs.add(organizationId);   // skip this company for the rest of the tick; no retry storm
        void recordMetric('conversation_triage_worker', 'refused_org', 1, 'jobs').catch(() => {});
      }
    } catch {
      errors++;   // executor threw (null result / failed write) - the hold was released by executeWithCredits
    }
  }

  void recordMetric('conversation_triage_worker', 'processed', processed, 'jobs').catch(() => {});
  void recordMetric('conversation_triage_worker', 'errors', errors, 'jobs').catch(() => {});
  void recordMetric('conversation_triage_worker', 'refused', refusedOrgs.size, 'jobs').catch(() => {});
  void recordMetric('conversation_triage_worker', 'duration_ms', Date.now() - startMs, 'ms').catch(() => {});

  return { processed, errors, refused: refusedOrgs.size };
}
