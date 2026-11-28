/**
 * Engagement Portal Counts — THE count definition for the /engagement portal.
 *
 * E4 (owner-approved, 2026-11-28). Before this file the portal had three count
 * definitions (getPlatformCounts, getDailyWorkQueue and a browser-side
 * recomputation in InboxDashboard). The one that reached the screen was capped
 * at the 10 visible DMs, was rebuilt from the selected tab's inbox page only,
 * counted a post with ten unanswered comments as 1, ignored "Mark resolved",
 * and rendered a failed read as 0. Every badge and header total the portal
 * shows now comes from `computeEngagementPortalCounts` below, served by
 * GET /api/engagement/platform-counts (and, for the same numbers in the legacy
 * shape, GET /api/engagement/work-queue).
 *
 * ── Definition (engagement-portal-counts.v1) ─────────────────────────────────
 *
 * Scope
 *   - Company: `engagement_threads.organization_id = <company>`; the company is
 *     the one the route resolved and access-checked. Messages are read only
 *     for thread ids that came out of that company-scoped thread read, so a
 *     message of another company can never be counted.
 *   - Not ignored: `engagement_threads.ignored = false` (Ignore removes it).
 *   - Window: the 60-day actionable window (ACTIONABLE_INBOX_LOOKBACK_DAYS) on
 *     the effective message time (getEffectiveMessageTimestamp).
 *   - All platforms in one pass. The selected tab has no influence.
 *   - True totals: every read is paged to exhaustion. Nothing is cut to a page
 *     size or to the list's visible top-N. A read that cannot be completed
 *     throws PortalCountsUnavailableError; the route answers 503 and the UI
 *     shows "unknown", never 0.
 *
 * "Company turn" (not inbound) — a message is the company's when
 *   isAuthorSelf(...) holds (direction 'outgoing', author_self / sender_self,
 *   the LinkedIn "You:" preview prefix, the LinkedIn mailbox self-sender), OR
 *   its author_id is one of the company's connected-account authors
 *   (getOrgAuthorIds — the same predicate getThreads uses), OR the thread row
 *   carries raw_payload.last_message_self = true (LinkedIn list-preview "You:",
 *   honoured exactly as the inbox route honours it).
 *
 * Coverage — an inbound item at time t is covered (answered/handled) when any
 *   of these exists for its thread (for DMs: for any sibling of its
 *   conversation, matching the inbox route's legacy-split DM grouping):
 *   1. a company turn at time >= t;
 *   2. an EXECUTED `community_ai_actions` row (read by
 *      readExecutedCoverageActions, shared with the inbox list) with action_type 'reply'|'dm'
 *      whose target_id maps to the thread and that covers the item
 *      (actionCoversMessage: same text, or action time >= t). 'dispatched',
 *      'sent_unverified' and every other status do NOT cover — the stated
 *      design (an unconfirmed send must not hide work);
 *   3. a persisted resolve: an `engagement_thread_events` row with
 *      event_type 'resolved' and created_at >= the item's INGESTION time
 *      (engagement_messages.created_at, not the provider time — an item that
 *      arrived after the resolve re-opens even if its platform time is
 *      earlier) (written by
 *      POST /api/engagement/thread/bulk-resolve, i.e. "Mark resolved").
 *      A new inbound item after the resolve re-opens the thread.
 *
 * Needs Response (DM) — unit: one conversation.
 *   A conversation needs response when its latest turn is a DM
 *   (message_type 'dm' | 'direct_message', or a DM-looking thread whose
 *   actionable list preview is the latest turn), that turn is inbound, it is
 *   inside the window, and it is not covered. Legacy-split LinkedIn DM threads
 *   for the same counterparty are one conversation (same grouping key as
 *   /api/engagement/inbox). Several inbound DMs in a row are still one item:
 *   one reply answers the conversation.
 *
 * People Reaction (comment) — unit: one comment.
 *   For a thread whose latest turn is a comment, every inbound comment inside
 *   the window that is not covered is one item. Two unanswered comments on
 *   one post count 2. Because coverage is thread-level (the persisted model
 *   has no per-comment handled state — see "schema step" below), a company
 *   reply on the post covers the comments that came before it, which is
 *   exactly when the inbox list stops showing that post.
 *
 *   Any other latest-turn type is in neither queue (same as the list).
 *
 * actionable_items = needs_response + people_reaction.
 * high_priority = actionable threads with triage_priority >= 7 (the existing
 *   triage threshold), used only for the tab accent colour.
 *
 * handled_threads — thread_id → ISO time of the latest handling the inbox list
 *   payload cannot see by itself (a persisted resolve, or a company turn found
 *   only through the connected-account author map). The UI hides a list item
 *   whose latest_message_time is not after this time, so a resolved thread
 *   leaves the list and the count together.
 *
 * Schema step (NOT done here, no migration in E4): there is no per-message
 * lifecycle state (new/seen/handled/resolved) and no action→message link
 * (community_ai_actions.target_id is free text). Per-comment resolve and
 * per-comment answered-ness need those columns.
 */

import { supabase } from '../db/supabaseClient';
import { getOrgAuthorIds } from './engagementThreadService';
import {
  isActionableDmPreview,
  isAuthorSelf,
  isDmMessageType,
} from '../../lib/engagement/messageRoles';
import { resolveDmThreadIdentity, type DmIdentityMessage } from '../../lib/engagement/dmThreadIdentity';
import {
  compareMessagesDescending,
  getEffectiveMessageTimestamp,
  parseMessageDateMs,
} from '../../lib/engagement/messageTime';
import {
  ACTIONABLE_INBOX_LOOKBACK_DAYS,
  ACTIONABLE_INBOX_LOOKBACK_MS,
  actionCoversMessage,
} from '../../lib/engagement/queueRules';

export const PORTAL_COUNTS_DEFINITION = 'engagement-portal-counts.v1';

export type PortalPlatformCounts = {
  needs_response: number;
  people_reaction: number;
  actionable_items: number;
  high_priority: number;
};

export type EngagementPortalCounts = {
  definition: typeof PORTAL_COUNTS_DEFINITION;
  organization_id: string;
  window_days: number;
  computed_at: string;
  platforms: Record<string, PortalPlatformCounts>;
  totals: PortalPlatformCounts;
  handled_threads: Record<string, string>;
};

/** Thrown when any read the definition depends on fails or is incomplete. */
export class PortalCountsUnavailableError extends Error {
  readonly code = 'ENGAGEMENT_COUNTS_UNAVAILABLE';
  constructor(detail: string) {
    super(`engagement counts unavailable: ${detail}`);
    this.name = 'PortalCountsUnavailableError';
  }
}

// ── Input rows (exactly the columns the reads select) ────────────────────────

export type PortalThreadRow = {
  id: string;
  platform: string | null;
  platform_thread_id?: string | null;
  raw_payload?: Record<string, unknown> | null;
};

export type PortalMessageRow = {
  id: string;
  thread_id: string;
  platform?: string | null;
  platform_message_id?: string | null;
  message_type?: string | null;
  direction?: string | null;
  content?: string | null;
  author_id?: string | null;
  raw_payload?: Record<string, unknown> | null;
  platform_created_at?: string | null;
  created_at?: string | null;
};

export type PortalActionRow = {
  target_id: string | null;
  status?: string | null;
  action_type?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  final_text?: string | null;
  suggested_text?: string | null;
};

export type PortalResolveEventRow = { thread_id: string; created_at: string | null };

export type PortalAuthorRow = {
  id: string;
  platform_user_id?: string | null;
  username?: string | null;
  display_name?: string | null;
  profile_url?: string | null;
};

export type PortalCountsInput = {
  organizationId: string;
  nowMs: number;
  threads: PortalThreadRow[];
  messages: PortalMessageRow[];
  orgAuthorIds: Set<string>;
  executedActions: PortalActionRow[];
  resolveEvents: PortalResolveEventRow[];
  counterpartyAuthors: PortalAuthorRow[];
  triagePriorityByThread: Map<string, number>;
};

// ── Pure derivation ──────────────────────────────────────────────────────────

type Turn = {
  kind: 'dm' | 'comment' | 'other';
  self: boolean;
  timeMs: number | null;
  time: string | null;
  text: string | null;
  /**
   * When Omnivyra received the turn (engagement_messages.created_at; a list
   * preview has only its own time). Resolve is compared against THIS, not the
   * provider time: an item ingested after the resolve was never seen by the
   * person who resolved, so it re-opens even if its platform time is earlier.
   */
  ingestMs: number | null;
  orgAuthorOnly: boolean;
};

const emptyPlatformCounts = (): PortalPlatformCounts => ({
  needs_response: 0,
  people_reaction: 0,
  actionable_items: 0,
  high_priority: 0,
});

function rp(row: { raw_payload?: Record<string, unknown> | null }): Record<string, unknown> {
  return row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
}

function messageIsSelfByFlags(m: PortalMessageRow): boolean {
  const p = rp(m);
  return isAuthorSelf({
    platform: m.platform,
    platform_message_id: m.platform_message_id,
    direction: m.direction,
    author_self: p.author_self as boolean | null | undefined,
    sender_self: p.sender_self as boolean | null | undefined,
    sender_username: p.sender_username as string | null | undefined,
    sender_profile_url: p.sender_profile_url as string | null | undefined,
    content: m.content,
  });
}

function normalizeDisplayNameKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized || ['unknown', 'linkedin member', 'member'].includes(normalized)) return null;
  return normalized;
}

function cleanTarget(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function derivePortalCounts(input: PortalCountsInput): EngagementPortalCounts {
  const windowStartMs = input.nowMs - ACTIONABLE_INBOX_LOOKBACK_MS;
  const threadById = new Map(input.threads.map((t) => [t.id, t]));

  // Messages per thread, newest first. Rows for a thread outside the company
  // read are dropped here as a second tenant guard.
  const messagesByThread = new Map<string, PortalMessageRow[]>();
  for (const m of [...input.messages].sort(compareMessagesDescending)) {
    if (!threadById.has(m.thread_id)) continue;
    const list = messagesByThread.get(m.thread_id) ?? [];
    list.push(m);
    messagesByThread.set(m.thread_id, list);
  }

  const isCompanyMessage = (m: PortalMessageRow) =>
    messageIsSelfByFlags(m) || (m.author_id ? input.orgAuthorIds.has(m.author_id) : false);

  // Latest turn per thread (mirrors getThreads' preview-vs-message rule and
  // the inbox route's DM-looking-thread fallback).
  const latestTurnByThread = new Map<string, Turn>();
  for (const t of input.threads) {
    const p = rp(t);
    const msgs = messagesByThread.get(t.id) ?? [];
    const latest = msgs[0] ?? null;
    const latestTime = latest ? getEffectiveMessageTimestamp(latest) : null;
    const latestMs = parseMessageDateMs(latestTime);
    const preview = typeof p.last_message_preview === 'string' ? p.last_message_preview.trim() : '';
    const previewTime = typeof p.last_message_at === 'string' ? p.last_message_at : null;
    const previewMs = parseMessageDateMs(previewTime);
    const previewActionable = isActionableDmPreview(preview);
    const previewWins = previewActionable && previewMs !== null && (latestMs === null || previewMs >= latestMs);
    const platformThreadId = (t.platform_thread_id ?? '').toString();
    const looksLikePostThread = /^urn:li:(activity|share|ugcPost):/i.test(platformThreadId);
    const looksLikeDmThread =
      !looksLikePostThread
      && ((typeof p.thread_url === 'string' && /\/messaging\//i.test(p.thread_url))
        || previewActionable
        || p.last_message_self === true);
    const threadSaysSelf = p.last_message_self === true;

    if (latest && !previewWins) {
      const flagsSelf = messageIsSelfByFlags(latest);
      const orgAuthor = latest.author_id ? input.orgAuthorIds.has(latest.author_id) : false;
      const type = (latest.message_type ?? '').toString().toLowerCase();
      latestTurnByThread.set(t.id, {
        kind: isDmMessageType(type) ? 'dm' : type === 'comment' ? 'comment' : 'other',
        self: flagsSelf || orgAuthor || threadSaysSelf,
        timeMs: latestMs,
        time: latestTime,
        text: latest.content ?? null,
        ingestMs: parseMessageDateMs(latest.created_at ?? null) ?? latestMs,
        orgAuthorOnly: orgAuthor && !flagsSelf && !threadSaysSelf,
      });
    } else if ((previewWins || !latest) && looksLikeDmThread && previewMs !== null) {
      latestTurnByThread.set(t.id, {
        kind: 'dm',
        self: threadSaysSelf,
        timeMs: previewMs,
        time: previewTime,
        text: preview || null,
        ingestMs: previewMs,
        orgAuthorOnly: false,
      });
    }
  }

  // Map executed-action target ids → threads (same target families the inbox
  // route matches: platform thread id, participant fields, message ids,
  // platform message ids, DM identity targets, counterparty author fields).
  const threadsByTarget = new Map<string, Set<string>>();
  const addTarget = (target: unknown, threadId: string) => {
    const key = cleanTarget(target);
    if (!key) return;
    const set = threadsByTarget.get(key) ?? new Set<string>();
    set.add(threadId);
    threadsByTarget.set(key, set);
  };

  const dmIdentityByThread = new Map<string, ReturnType<typeof resolveDmThreadIdentity>>();
  for (const t of input.threads) {
    const p = rp(t);
    addTarget(t.platform_thread_id, t.id);
    addTarget(p.participant_profile_url, t.id);
    addTarget(p.participant_username, t.id);
    addTarget(p.participant_name, t.id);
    for (const m of messagesByThread.get(t.id) ?? []) {
      addTarget(m.id, t.id);
      addTarget(m.platform_message_id, t.id);
    }
    if (latestTurnByThread.get(t.id)?.kind === 'dm') {
      const dmMessages: DmIdentityMessage[] = (messagesByThread.get(t.id) ?? [])
        .filter((m) => isDmMessageType(m.message_type))
        .map((m) => ({
          platform: m.platform ?? null,
          platform_message_id: m.platform_message_id ?? null,
          message_type: m.message_type ?? null,
          direction: m.direction ?? null,
          content: m.content ?? null,
          author_id: m.author_id ?? null,
          raw_payload: m.raw_payload ?? null,
        }));
      const identity = resolveDmThreadIdentity({
        platform: t.platform ?? '',
        threadId: t.id,
        platformThreadId: t.platform_thread_id ?? null,
        threadRawPayload: t.raw_payload ?? null,
        latestMessage: dmMessages[0] ?? null,
        messages: dmMessages,
      });
      dmIdentityByThread.set(t.id, identity);
      for (const target of identity.targetIds) addTarget(target, t.id);
    }
  }

  const uniqueAuthorIdByDisplayName = new Map<string, string>();
  const duplicateDisplayNames = new Set<string>();
  for (const a of input.counterpartyAuthors) {
    const nameKey = normalizeDisplayNameKey(a.display_name);
    if (nameKey) {
      const existing = uniqueAuthorIdByDisplayName.get(nameKey);
      if (existing && existing !== a.id) duplicateDisplayNames.add(nameKey);
      else uniqueAuthorIdByDisplayName.set(nameKey, a.id);
    }
    for (const [threadId, identity] of dmIdentityByThread.entries()) {
      if (identity.counterpartyAuthorId !== a.id) continue;
      addTarget(a.platform_user_id, threadId);
      addTarget(a.profile_url, threadId);
      addTarget(a.username, threadId);
      addTarget(a.display_name, threadId);
    }
  }
  for (const name of duplicateDisplayNames) uniqueAuthorIdByDisplayName.delete(name);

  // Executed actions per thread.
  const actionsByThread = new Map<string, PortalActionRow[]>();
  for (const action of input.executedActions) {
    if ((action.status ?? '').trim().toLowerCase() !== 'executed') continue;
    const type = (action.action_type ?? '').trim().toLowerCase();
    if (type !== 'reply' && type !== 'dm') continue;
    const target = cleanTarget(action.target_id);
    if (!target) continue;
    for (const threadId of threadsByTarget.get(target) ?? []) {
      const list = actionsByThread.get(threadId) ?? [];
      list.push(action);
      actionsByThread.set(threadId, list);
    }
  }

  // Latest persisted resolve per thread.
  const resolvedAtMsByThread = new Map<string, number>();
  for (const ev of input.resolveEvents) {
    if (!threadById.has(ev.thread_id)) continue;
    const ms = parseMessageDateMs(ev.created_at);
    if (ms === null) continue;
    resolvedAtMsByThread.set(ev.thread_id, Math.max(ms, resolvedAtMsByThread.get(ev.thread_id) ?? -Infinity));
  }

  const actionCovers = (threadId: string, time: string | null, text: string | null) =>
    (actionsByThread.get(threadId) ?? []).some((a) =>
      actionCoversMessage(
        a.updated_at ?? a.created_at ?? null,
        time,
        a.final_text ?? a.suggested_text ?? null,
        text,
      ),
    );

  const inWindow = (ms: number | null) => ms === null || ms >= windowStartMs;

  const platforms: Record<string, PortalPlatformCounts> = {};
  const cell = (platform: string | null) => {
    const slug = normalizePortalPlatform(platform);
    platforms[slug] = platforms[slug] ?? emptyPlatformCounts();
    return platforms[slug];
  };
  const handled = new Map<string, number>();
  const markHandled = (threadIds: string[], ms: number | null) => {
    if (ms === null) return;
    for (const id of threadIds) handled.set(id, Math.max(ms, handled.get(id) ?? -Infinity));
  };

  // ── DMs: group legacy-split siblings into one conversation. ──
  const dmGroups = new Map<string, string[]>();
  for (const [threadId, identity] of dmIdentityByThread.entries()) {
    const t = threadById.get(threadId)!;
    const nameOnly = identity.key.startsWith('name:') ? identity.key.slice('name:'.length) : null;
    const aliasAuthorId = nameOnly ? uniqueAuthorIdByDisplayName.get(nameOnly) : undefined;
    const groupKey = aliasAuthorId
      ? `${t.platform}:author:${aliasAuthorId}`
      : `${t.platform}:${identity.key}`;
    const list = dmGroups.get(groupKey) ?? [];
    list.push(threadId);
    dmGroups.set(groupKey, list);
  }
  for (const siblingIds of dmGroups.values()) {
    let newestId = siblingIds[0];
    for (const id of siblingIds) {
      const a = latestTurnByThread.get(id)?.timeMs ?? 0;
      const b = latestTurnByThread.get(newestId)?.timeMs ?? 0;
      if (a > b) newestId = id;
    }
    const turn = latestTurnByThread.get(newestId)!;
    const resolvedMs = Math.max(...siblingIds.map((id) => resolvedAtMsByThread.get(id) ?? -Infinity));
    const resolveCoversLatest =
      Number.isFinite(resolvedMs) && (turn.ingestMs === null || resolvedMs >= turn.ingestMs);
    // handled_threads value must be >= the list's latest_message_time (provider
    // time) so the list hides exactly what the count treats as resolved.
    if (resolveCoversLatest) markHandled(siblingIds, Math.max(resolvedMs, turn.timeMs ?? -Infinity));
    if (turn.orgAuthorOnly) markHandled(siblingIds, turn.timeMs);
    if (turn.self) continue;
    if (!inWindow(turn.timeMs)) continue;
    // Inbox parity: an executed covering action on ANY sibling covers the conversation.
    const covered = siblingIds.some((id) => {
      const own = latestTurnByThread.get(id)!;
      return actionCovers(id, own.time, own.text);
    });
    if (covered) continue;
    if (resolveCoversLatest) continue;
    const c = cell(threadById.get(newestId)!.platform);
    c.needs_response += 1;
    c.actionable_items += 1;
    if (siblingIds.some((id) => (input.triagePriorityByThread.get(id) ?? 0) >= 7)) c.high_priority += 1;
  }

  // ── Comments: one item per uncovered inbound comment. ──
  for (const t of input.threads) {
    const turn = latestTurnByThread.get(t.id);
    if (!turn || turn.kind !== 'comment') continue;
    const resolvedMs = resolvedAtMsByThread.get(t.id) ?? -Infinity;
    if (Number.isFinite(resolvedMs) && (turn.ingestMs === null || resolvedMs >= turn.ingestMs)) {
      markHandled([t.id], Math.max(resolvedMs, turn.timeMs ?? -Infinity));
    }
    if (turn.orgAuthorOnly) markHandled([t.id], turn.timeMs);
    if (turn.self) continue;
    const msgs = messagesByThread.get(t.id) ?? [];
    // Newest company turn on the thread (any message type).
    let lastCompanyMs = -Infinity;
    for (const m of msgs) {
      if (!isCompanyMessage(m)) continue;
      const ms = parseMessageDateMs(getEffectiveMessageTimestamp(m));
      if (ms !== null && ms > lastCompanyMs) lastCompanyMs = ms;
    }
    let pending = 0;
    for (const m of msgs) {
      if ((m.message_type ?? '').toString().toLowerCase() !== 'comment') continue;
      if (isCompanyMessage(m)) continue;
      const time = getEffectiveMessageTimestamp(m);
      const ms = parseMessageDateMs(time);
      if (!inWindow(ms)) continue;
      // Company turns compare on provider time (conversation order); resolve
      // compares on ingestion time (what the resolver could have seen).
      const ingestMs = parseMessageDateMs(m.created_at ?? null) ?? ms;
      const resolvedAfter = ingestMs === null ? Number.isFinite(resolvedMs) : resolvedMs >= ingestMs;
      const companyAfter = ms === null ? Number.isFinite(lastCompanyMs) : lastCompanyMs >= ms;
      const handledAfter = resolvedAfter || companyAfter;
      if (handledAfter) continue;
      if (actionCovers(t.id, time, m.content ?? null)) continue;
      pending += 1;
    }
    if (pending === 0) continue;
    const c = cell(t.platform);
    c.people_reaction += pending;
    c.actionable_items += pending;
    if ((input.triagePriorityByThread.get(t.id) ?? 0) >= 7) c.high_priority += 1;
  }

  const totals = emptyPlatformCounts();
  for (const c of Object.values(platforms)) {
    totals.needs_response += c.needs_response;
    totals.people_reaction += c.people_reaction;
    totals.actionable_items += c.actionable_items;
    totals.high_priority += c.high_priority;
  }

  const handled_threads: Record<string, string> = {};
  for (const [id, ms] of handled.entries()) handled_threads[id] = new Date(ms).toISOString();

  return {
    definition: PORTAL_COUNTS_DEFINITION,
    organization_id: input.organizationId,
    window_days: ACTIONABLE_INBOX_LOOKBACK_DAYS,
    computed_at: new Date(input.nowMs).toISOString(),
    platforms,
    totals,
    handled_threads,
  };
}

/** Same slug the tabs use ('x' → 'twitter'). */
export function normalizePortalPlatform(platform: string | null | undefined): string {
  const lower = (platform ?? '').toString().trim().toLowerCase();
  if (lower === 'x') return 'twitter';
  return lower || 'unknown';
}

// ── Reads ────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;
const ID_CHUNK = 200;
/** Hard ceiling per read. Reaching it is reported as unavailable, never truncated. */
const MAX_ROWS_PER_READ = 200_000;

type PageResult<T> = { data: T[] | null; error: { message?: string } | null };

async function readAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new PortalCountsUnavailableError(`${label}: ${error.message ?? 'read failed'}`);
    // A missing list is not an empty list.
    if (!Array.isArray(data)) throw new PortalCountsUnavailableError(`${label}: no rows array in response`);
    out.push(...data);
    if (data.length < PAGE_SIZE) return out;
    if (out.length >= MAX_ROWS_PER_READ) {
      throw new PortalCountsUnavailableError(`${label}: more than ${MAX_ROWS_PER_READ} rows`);
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * THE executed-action read behind "an executed reply covers this item", shared
 * by this count and the inbox list (/api/engagement/inbox) so both use the same
 * window, the same paging and the same failure semantics (E4 review #2).
 * Executed reply/dm actions of the company with updated_at or created_at on or
 * after `cutoffIso`; paged to exhaustion; throws PortalCountsUnavailableError
 * on any read failure — never "no actions" (which would show answered work as
 * open).
 */
export async function readExecutedCoverageActions(
  organizationId: string,
  cutoffIso: string,
): Promise<PortalActionRow[]> {
  return readAllPages<PortalActionRow>('community_ai_actions', (from, to) =>
    supabase
      .from('community_ai_actions')
      .select('target_id, status, action_type, created_at, updated_at, final_text, suggested_text')
      .eq('organization_id', organizationId)
      .eq('status', 'executed')
      .in('action_type', ['dm', 'reply'])
      .or(`updated_at.gte.${cutoffIso},created_at.gte.${cutoffIso}`)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<PortalActionRow>>,
  );
}

/** Default lower bound of the coverage-action window (the actionable window). */
export function coverageWindowCutoffIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - ACTIONABLE_INBOX_LOOKBACK_MS).toISOString();
}

/**
 * The single count function the portal API serves. Throws
 * PortalCountsUnavailableError when any read fails.
 */
export async function computeEngagementPortalCounts(
  organizationId: string,
  options: { nowMs?: number } = {},
): Promise<EngagementPortalCounts> {
  const org = (organizationId ?? '').toString().trim();
  if (!org) throw new PortalCountsUnavailableError('organization id missing');
  const nowMs = options.nowMs ?? Date.now();
  const cutoffIso = coverageWindowCutoffIso(nowMs);

  let orgAuthorIds: Set<string>;
  try {
    orgAuthorIds = await getOrgAuthorIds(org, { strict: true });
  } catch (err) {
    throw new PortalCountsUnavailableError(`company authors: ${(err as Error)?.message ?? 'read failed'}`);
  }

  const threads = await readAllPages<PortalThreadRow>('engagement_threads', (from, to) =>
    supabase
      .from('engagement_threads')
      .select('id, platform, platform_thread_id, raw_payload')
      .eq('organization_id', org)
      .eq('ignored', false)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<PortalThreadRow>>,
  );
  const threadIds = threads.map((t) => t.id).filter(Boolean);

  const messages: PortalMessageRow[] = [];
  const triagePriorityByThread = new Map<string, number>();
  for (const ids of chunk(threadIds, ID_CHUNK)) {
    messages.push(
      ...(await readAllPages<PortalMessageRow>('engagement_messages', (from, to) =>
        supabase
          .from('engagement_messages')
          .select('id, thread_id, platform, platform_message_id, message_type, direction, content, author_id, raw_payload, platform_created_at, created_at')
          .in('thread_id', ids)
          .or(`platform_created_at.gte.${cutoffIso},created_at.gte.${cutoffIso}`)
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<PortalMessageRow>>,
      )),
    );
    const classifications = await readAllPages<{ thread_id: string; triage_priority: number | null }>(
      'engagement_thread_classification',
      (from, to) =>
        supabase
          .from('engagement_thread_classification')
          .select('thread_id, triage_priority')
          .eq('organization_id', org)
          .in('thread_id', ids)
          .order('thread_id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<{ thread_id: string; triage_priority: number | null }>>,
    );
    for (const c of classifications) {
      const p = Number(c.triage_priority ?? 0) || 0;
      triagePriorityByThread.set(c.thread_id, Math.max(p, triagePriorityByThread.get(c.thread_id) ?? 0));
    }
  }

  const executedActions = await readExecutedCoverageActions(org, cutoffIso);

  const resolveEvents = await readAllPages<PortalResolveEventRow>('engagement_thread_events', (from, to) =>
    supabase
      .from('engagement_thread_events')
      .select('thread_id, created_at')
      .eq('organization_id', org)
      .eq('event_type', 'resolved')
      .gte('created_at', cutoffIso)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<PortalResolveEventRow>>,
  );

  // Counterparty authors (DM grouping by display-name alias + action targets).
  const counterpartyIds = Array.from(
    new Set(
      messages
        .filter((m) => isDmMessageType(m.message_type) && m.author_id && !orgAuthorIds.has(m.author_id))
        .map((m) => m.author_id as string),
    ),
  );
  const counterpartyAuthors: PortalAuthorRow[] = [];
  for (const ids of chunk(counterpartyIds, ID_CHUNK)) {
    counterpartyAuthors.push(
      ...(await readAllPages<PortalAuthorRow>('engagement_authors', (from, to) =>
        supabase
          .from('engagement_authors')
          .select('id, platform_user_id, username, display_name, profile_url')
          .in('id', ids)
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<PortalAuthorRow>>,
      )),
    );
  }

  return derivePortalCounts({
    organizationId: org,
    nowMs,
    threads,
    messages,
    orgAuthorIds,
    executedActions,
    resolveEvents,
    counterpartyAuthors,
    triagePriorityByThread,
  });
}
