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

export const TRIAGE_BATCH_LIMIT = 15;
export const TRIAGE_PAGE_SIZE = 100;
export const TRIAGE_MAX_PAGES = 5;
export const TRIAGE_PER_ORG_CAP = 5;

type Candidate = { threadId: string; organizationId: string };

/** Pick up to TRIAGE_BATCH_LIMIT threads needing classification; null = a read failed (fail closed). */
async function selectCandidates(): Promise<Candidate[] | null> {
  const picked: Candidate[] = [];
  const perOrg = new Map<string, number>();

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

  for (const { threadId, organizationId } of candidates) {
    const controls = await getControls(organizationId);
    if (!controls.triage_engine_enabled) continue;

    // ONE provider call per thread per tick (F2c). A null result is final for this tick.
    const result = await classifyThread(threadId, organizationId);
    if (!result) {
      errors++;
      continue;
    }

    try {
      // Only the idempotent DB write is retried - never the AI call.
      await executeWithRetry('conversationTriageWorker', { threadId, organizationId },
        () => writeClassification(threadId, organizationId, result));
      processed++;
    } catch {
      errors++;
    }
  }

  void recordMetric('conversation_triage_worker', 'processed', processed, 'jobs').catch(() => {});
  void recordMetric('conversation_triage_worker', 'errors', errors, 'jobs').catch(() => {});
  void recordMetric('conversation_triage_worker', 'duration_ms', Date.now() - startMs, 'ms').catch(() => {});

  return { processed, errors };
}
