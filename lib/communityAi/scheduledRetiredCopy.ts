/**
 * Community AI scheduling is retired (owner ruling 2026-11-20). The scheduler never ran in production, so a row
 * that was "scheduled" was NEVER sent. Such rows show under Pending with this sentence and the normal Send now /
 * Skip actions (the existing execute path: /api/community-ai/actions/execute accepts `scheduled` and still enforces
 * approved_at). Own module so tests that factory-mock the view's hook still see it.
 */
export const SEND_NOW_LABEL = 'Send now';

export function scheduledNotSentCopy(scheduledAt: string | null | undefined): string {
  const when = scheduledAt ? new Date(scheduledAt) : null;
  const label = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : 'an earlier time';
  return `Scheduled for ${label} — scheduled sending isn't available, so this reply was not sent.`;
}
