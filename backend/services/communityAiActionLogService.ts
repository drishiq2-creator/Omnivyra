import { ownedDbTable } from '../db/writeOwner';
import { recordRawCounter } from '../observability';

/**
 * Every event type a caller may log. THE single source: the logger's parameter is typed from it (a call site cannot
 * pass anything else), and backend/tests/realschema/community_ai_action_logs_insert.test.ts inserts EVERY value into
 * the real table - so a new type the table's CHECK does not accept fails CI by construction (a9, 2026-11-20; b3 rule).
 * The CHECK admits all of them since 20270217000071 (it refused 'skipped_due_to_platform_policy' and
 * 'sent_unverified' before).
 */
export const COMMUNITY_AI_ACTION_EVENT_TYPES = Object.freeze([
  'approved',
  'executed',
  'failed',
  'skipped',
  'scheduled',
  'auto_executed',
  'skipped_due_to_platform_policy',
  // A send the platform accepted without confirmation - distinct from 'executed' (b3 standing rule 1). Admitted by
  // 20270217000071; execute.ts writes it once the terminal event moves into persistExecutionResult (PL-108 step 2).
  'sent_unverified',
] as const);
export type ActionEventType = (typeof COMMUNITY_AI_ACTION_EVENT_TYPES)[number];

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
  const payload = {
    action_id: input.action_id,
    tenant_id: input.tenant_id,
    organization_id: input.organization_id,
    event_type: input.event_type,
    event_payload: input.event_payload ?? null,
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
