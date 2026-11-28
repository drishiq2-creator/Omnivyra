import { isDmMessageType } from './messageRoles';

export const ACTIONABLE_INBOX_LOOKBACK_DAYS = 60;
export const ACTIONABLE_INBOX_LOOKBACK_MS =
  ACTIONABLE_INBOX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
/**
 * Visible-list cap for the Needs Response LIST only. E4: totals and badges are
 * never derived from this slice — they come from the server count definition
 * (backend/services/engagementPortalCountsService.ts).
 */
export const NEEDS_RESPONSE_VISIBLE_LIMIT = 10;

export type EngagementQueueThread = {
  thread_id?: string | null;
  /** Legacy-split DM siblings collapsed into this row by the inbox route. */
  sibling_thread_ids?: string[] | null;
  latest_message_type?: string | null;
  latest_message_direction?: string | null;
  latest_message_author_self?: boolean | null;
  latest_message_time?: string | null;
  has_completed_outbound_action?: boolean | null;
  /**
   * Legacy field name kept for API compatibility. The value now means
   * "a confirmed outbound action covers the latest message", not pending.
   */
  has_pending_outbound_action?: boolean | null;
  unread_count?: number | null;
  priority_score?: number | null;
  triage_priority?: number | null;
};

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function latestMessageFromSelf(thread: EngagementQueueThread): boolean {
  return thread.latest_message_direction === 'outgoing'
    || thread.latest_message_author_self === true;
}

export function hasConfirmedOutboundAction(thread: EngagementQueueThread): boolean {
  return thread.has_completed_outbound_action === true
    || thread.has_pending_outbound_action === true;
}

export function isWithinActionableWindow(
  thread: EngagementQueueThread,
  nowMs = Date.now(),
): boolean {
  const ts = parseTimeMs(thread.latest_message_time);
  if (ts === null) return true;
  return ts >= nowMs - ACTIONABLE_INBOX_LOOKBACK_MS;
}

export function isNeedsResponseThread(
  thread: EngagementQueueThread,
  nowMs = Date.now(),
): boolean {
  return isDmMessageType(thread.latest_message_type)
    && !latestMessageFromSelf(thread)
    && !hasConfirmedOutboundAction(thread)
    && isWithinActionableWindow(thread, nowMs);
}

export function isPeopleReactionThread(
  thread: EngagementQueueThread,
  nowMs = Date.now(),
): boolean {
  return thread.latest_message_type === 'comment'
    && !latestMessageFromSelf(thread)
    && !hasConfirmedOutboundAction(thread)
    && isWithinActionableWindow(thread, nowMs);
}

/**
 * thread_id → ISO time of the latest handling the server knows about that the
 * inbox list payload does not carry (a persisted "Mark resolved", or a company
 * turn identified through the connected-account author map). Served as
 * `handled_threads` by GET /api/engagement/platform-counts.
 */
export type HandledThreadMap = Record<string, string>;

/**
 * True when the server reports this thread (or a collapsed sibling) handled at
 * or after its latest message. A newer inbound message re-opens it.
 */
export function isHandledByServer(
  thread: EngagementQueueThread,
  handled: HandledThreadMap | null | undefined,
): boolean {
  if (!handled) return false;
  const ids = [thread.thread_id, ...(thread.sibling_thread_ids ?? [])].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  const latestMs = parseTimeMs(thread.latest_message_time);
  return ids.some((id) => {
    const handledMs = parseTimeMs(handled[id]);
    if (handledMs === null) return false;
    return latestMs === null || handledMs >= latestMs;
  });
}

/**
 * Does an executed outbound action cover a message? Same text, or the action
 * happened at/after the message. A message without a time is covered by any
 * action (inbox-route parity); an action without a time covers nothing.
 */
export function actionCoversMessage(
  actionTime: string | null | undefined,
  messageTime: string | null | undefined,
  actionText?: string | null,
  messageText?: string | null,
): boolean {
  const norm = (v: string | null | undefined) => {
    const n = (v ?? '').replace(/\s+/g, ' ').trim();
    return n.length > 0 ? n : null;
  };
  const a = norm(actionText);
  const m = norm(messageText);
  if (a && m && a === m) return true;
  const messageMs = parseTimeMs(messageTime);
  if (messageMs === null) return true;
  const actionMs = parseTimeMs(actionTime);
  if (actionMs === null) return false;
  return actionMs >= messageMs;
}

function compareThreadsForAction<T extends EngagementQueueThread>(a: T, b: T): number {
  const recencyA = parseTimeMs(a.latest_message_time) ?? 0;
  const recencyB = parseTimeMs(b.latest_message_time) ?? 0;
  if (recencyB !== recencyA) return recencyB - recencyA;

  const unreadA = (a.unread_count ?? 0) > 0 ? 1 : 0;
  const unreadB = (b.unread_count ?? 0) > 0 ? 1 : 0;
  if (unreadB !== unreadA) return unreadB - unreadA;

  const urgencyA = a.triage_priority ?? a.priority_score ?? 0;
  const urgencyB = b.triage_priority ?? b.priority_score ?? 0;
  return urgencyB - urgencyA;
}

export function sortThreadsForAction<T extends EngagementQueueThread>(items: T[]): T[] {
  return [...items].sort(compareThreadsForAction);
}

export function selectNeedsResponseThreads<T extends EngagementQueueThread>(
  items: T[],
  nowMs = Date.now(),
  handled?: HandledThreadMap | null,
): T[] {
  return sortThreadsForAction(
    items.filter((thread) => isNeedsResponseThread(thread, nowMs) && !isHandledByServer(thread, handled)),
  );
}

export function selectPeopleReactionThreads<T extends EngagementQueueThread>(
  items: T[],
  nowMs = Date.now(),
  handled?: HandledThreadMap | null,
): T[] {
  return sortThreadsForAction(
    items.filter((thread) => isPeopleReactionThread(thread, nowMs) && !isHandledByServer(thread, handled)),
  );
}
