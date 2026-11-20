import { ownedDbTable } from '../db/writeOwner';
import { recordRawCounter } from '../observability';

/**
 * Every event type a caller may log. THE single source: the logger's parameter is typed from it (a call site cannot
 * pass anything else), and backend/tests/realschema/community_ai_action_logs_insert.test.ts inserts EVERY value
 * (after storedEventType) into the real table - so a new type the table's CHECK does not accept fails CI by
 * construction (a9, 2026-11-20; b3 rule).
 */
export const COMMUNITY_AI_ACTION_EVENT_TYPES = Object.freeze([
  'approved',
  'executed',
  'failed',
  'skipped',
  'scheduled',
  'auto_executed',
  'skipped_due_to_platform_policy',
] as const);
export type ActionEventType = (typeof COMMUNITY_AI_ACTION_EVENT_TYPES)[number];

/**
 * The value WRITTEN to community_ai_action_logs.event_type. The table's CHECK accepts approved / executed / failed /
 * skipped / scheduled / auto_executed - not 'skipped_due_to_platform_policy', so every such insert used to fail
 * (warned, never counted). It is stored as 'skipped' and the original type is kept in event_payload.logged_as.
 */
export function storedEventType(t: ActionEventType): Exclude<ActionEventType, 'skipped_due_to_platform_policy'> {
  return t === 'skipped_due_to_platform_policy' ? 'skipped' : t;
}

/**
 * Record one community-AI action event. NEVER throws (a log write must not break the action it describes) and is
 * never silent: a refused insert or a thrown rejection is logged COMMUNITY_AI_ACTION_LOG_FAILED at error level and
 * counted (community_ai_action_log_failed{event_type}). Returns what happened.
 */
export const logCommunityAiActionEvent = async (input: {
  action_id: string;
  tenant_id: string;
  organization_id: string;
  event_type: ActionEventType;
  event_payload?: any;
}): Promise<'recorded' | 'failed'> => {
  const stored = storedEventType(input.event_type);
  const basePayload = input.event_payload ?? null;
  const payload = {
    action_id: input.action_id,
    tenant_id: input.tenant_id,
    organization_id: input.organization_id,
    event_type: stored,
    event_payload:
      stored === input.event_type
        ? basePayload
        : { ...(basePayload && typeof basePayload === 'object' ? basePayload : { value: basePayload }), logged_as: input.event_type },
    created_at: new Date().toISOString(),
  };
  let message: string | null = null;
  try {
    const { error } = await ownedDbTable('community_ai_action_logs').insert(payload);
    if (error) message = String(error.message ?? 'insert error');
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === null) return 'recorded';
  console.error('COMMUNITY_AI_ACTION_LOG_FAILED', JSON.stringify({ event_type: input.event_type, action_id: input.action_id, message: message.slice(0, 200) }));
  try { recordRawCounter('community_ai_action_log_failed', 1, { event_type: input.event_type }); } catch { /* never break the caller */ }
  return 'failed';
};
