/**
 * Community AI scheduling is retired (owner ruling 2026-11-20). The scheduler never ran in production, so a row
 * that was "scheduled" was NEVER sent. Such rows show under Pending with this sentence and the normal Send now /
 * Skip actions (the existing execute path: /api/community-ai/actions/execute accepts `scheduled` and still enforces
 * approved_at). Own module so tests that factory-mock the view's hook still see it.
 */
export const SEND_NOW_LABEL = 'Send now';
/** An approved reply that hasn't been sent (approve.ts sets status 'approved' without executing). */
export const APPROVED_NOT_SENT_LABEL = 'Approved — not sent yet';

/**
 * How long an approved reply has been waiting (7c, 2026-11-20). These are replies to real posts that may be weeks
 * old; the operator's question is "is this still worth sending?", which needs the age in front of them.
 * `now` is a parameter so tests use a fixed clock.
 */
export function approvedAgeCopy(approvedAt: string | null | undefined, createdAt: string | null | undefined, now: number): string | null {
  const iso = approvedAt || createdAt;
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return null;
  const days = Math.max(0, Math.floor((now - t) / 86_400_000));
  const verb = approvedAt ? 'Approved' : 'Created';
  const age = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `${verb} ${age} — check it's still worth sending.`;
}

export function scheduledNotSentCopy(scheduledAt: string | null | undefined): string {
  const when = scheduledAt ? new Date(scheduledAt) : null;
  const label = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : 'an earlier time';
  return `Scheduled for ${label} — scheduled sending isn't available, so this reply was not sent.`;
}
