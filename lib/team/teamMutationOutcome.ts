/**
 * Team Management (/team-management) mutation outcomes and Idempotency-Key lifetime (2026-11-20, audit F23-F25).
 *
 * /api/company/users is wrapped in withIdempotency (pages/api/company/users.ts), which REPLAYS the stored response
 * for a key whose row is `completed` and the payload hash matches. A key minted per click never replays, so the old
 * comment "a fresh key per user action makes each mutation safely retryable" was false. Here one key is held per
 * submission (method + body) until the outcome is known, and dropped once the server has answered.
 *
 * Copy for an unknown outcome claims nothing and gives no "safe to retry" promise: a row left `failed` (handler
 * error after the email went out) is re-run on the same key, not replayed. It points at the team list, which the
 * page re-reads.
 */

export type TeamMutationKind = 'invite' | 'reinvite' | 'role' | 'deactivate' | 'remove';

export type TeamMutationOutcome =
  | { kind: 'done'; body: Record<string, unknown> }
  /** The server answered and did nothing (validation, permission, key conflict). */
  | { kind: 'refused'; message: string }
  /** No answer we can trust: a lost connection (apiFetch: 503 today, 599 after #17), any 5xx, or still in progress. */
  | { kind: 'unknown'; reason: 'no_answer' | 'in_progress' };

export const TEAM_UNKNOWN_COPY: Record<TeamMutationKind, string> = {
  invite: "We're not sure the invitation was sent. Check the team list before sending it again.",
  reinvite: "We're not sure the re-invite was sent. Check the member's status before sending it again.",
  role: "We're not sure the role change was saved. Check the team list.",
  deactivate: "We're not sure the user was deactivated. Check the team list.",
  remove: "We're not sure the user was removed. Check the team list.",
};
export const TEAM_IN_PROGRESS_COPY =
  'That request is still being processed. Check the team list in a moment.';
export const TEAM_LOAD_FAILED =
  "We couldn't load your team, so we can't show who has access.";

const REFUSED_FALLBACK: Record<TeamMutationKind, string> = {
  invite: 'Failed to invite user',
  reinvite: 'Failed to reinvite user',
  role: 'Failed to update role',
  deactivate: 'Failed to deactivate user',
  remove: 'Failed to remove user',
};

const LOAD_REFUSAL_COPY: Record<string, string> = {
  FORBIDDEN_ROLE:
    "You don't have permission to view this company's team. If you were invited, accept the invite first. Otherwise select a company you belong to or contact your admin.",
  COMPANY_ACCESS_DENIED: "You don't have access to this company. Please select a company you belong to from the dropdown.",
  UNAUTHORIZED: 'Please log in again to view team members.',
};

/**
 * F23: what to show when the roster read did not succeed. A known refusal keeps its specific sentence; anything else
 * (lost connection, 5xx, an unknown code, an unreadable body) is the honest generic failure, never a raw code and
 * never an empty roster. `status` null = the request threw.
 */
export function teamLoadFailureMessage(status: number | null, body: unknown): string {
  const code = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  if (status !== null && status < 500 && typeof code === 'string' && LOAD_REFUSAL_COPY[code]) return LOAD_REFUSAL_COPY[code];
  return TEAM_LOAD_FAILED;
}

/** `status` null = the request threw or its body could not be read. */
export function classifyTeamMutation(
  kind: TeamMutationKind,
  status: number | null,
  body: unknown,
): TeamMutationOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status === null) return { kind: 'unknown', reason: 'no_answer' };
  if (status >= 200 && status < 300) return { kind: 'done', body: b };
  if (status === 409 && b.code === 'IDEMPOTENCY_IN_PROGRESS') return { kind: 'unknown', reason: 'in_progress' };
  if (status >= 500) return { kind: 'unknown', reason: 'no_answer' };
  const message = typeof b.error === 'string' && b.error.trim() ? b.error : REFUSED_FALLBACK[kind];
  return { kind: 'refused', message };
}

export function unknownOutcomeMessage(kind: TeamMutationKind, outcome: TeamMutationOutcome): string {
  return outcome.kind === 'unknown' && outcome.reason === 'in_progress' ? TEAM_IN_PROGRESS_COPY : TEAM_UNKNOWN_COPY[kind];
}

/** The request identity withIdempotency hashes: method + body (query is empty for these calls). */
export function submissionSignature(method: string, body: Record<string, unknown>): string {
  return `${method.toUpperCase()} ${JSON.stringify(body)}`;
}

/**
 * One key per submission. `keyFor` returns the SAME key for the same signature until `settle` is called;
 * a different payload gets its own key (reusing a key with another body is a 409 IDEMPOTENCY_CONFLICT).
 */
export class HeldIdempotencyKeys {
  private readonly keys = new Map<string, string>();
  constructor(private readonly mint: () => string) {}
  keyFor(signature: string): string {
    let key = this.keys.get(signature);
    if (!key) {
      key = this.mint();
      this.keys.set(signature, key);
    }
    return key;
  }
  settle(signature: string): void {
    this.keys.delete(signature);
  }
  /** Keep the key only while the outcome is unknown. */
  record(signature: string, outcome: TeamMutationOutcome): void {
    if (outcome.kind !== 'unknown') this.settle(signature);
  }
}
