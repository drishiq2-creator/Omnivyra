/**
 * POST /api/community-ai/actions/execute outcome, shared by the three execute call sites in useCommunityActions
 * (2026-11-20). The server claims the row with a compare-and-set (UPDATE … WHERE status IN executable), so of two
 * concurrent presses (two tabs / two operators) exactly one sends and the other gets 409 ACTION_NOT_PENDING.
 * That loser used to see the raw code; a lost response used to say "Execution failed" though the outcome is unknown.
 */
export type ExecuteOutcome =
  | { kind: 'done' }
  /** Someone else already sent it or is sending it; reload to show the real state. */
  | { kind: 'already'; message: string }
  /** No trustworthy answer (lost connection / 5xx): claim nothing, reload, no retry advice. */
  | { kind: 'unknown'; message: string }
  /** The server refused (approval, playbook, …): nothing was sent. */
  | { kind: 'refused'; message: string };

export const EXECUTE_ALREADY_HANDLED =
  'This reply was already sent, or is being sent, from somewhere else. We refreshed the list.';
export const EXECUTE_UNKNOWN =
  "We're not sure this reply was sent. We refreshed the list; check its status before sending again.";

/** `status` null = the request threw. fetchWithAuth (apiFetch) answers a lost connection with a non-2xx. */
export function classifyExecute(status: number | null, body: unknown): ExecuteOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status !== null && status >= 200 && status < 300) return { kind: 'done' };
  if (status === 409 && b.error === 'ACTION_NOT_PENDING') return { kind: 'already', message: EXECUTE_ALREADY_HANDLED };
  if (status === null || status >= 500) return { kind: 'unknown', message: EXECUTE_UNKNOWN };
  const code = typeof b.error === 'string' ? b.error : '';
  // PLAYBOOK_VIOLATION is the only refusal whose `reason` is a human sentence (the playbook validator's);
  // APPROVAL_REQUIRED's reason is another code (NOT_APPROVED). Never interpolate a code.
  if (code === 'PLAYBOOK_VIOLATION' && typeof b.reason === 'string' && b.reason.trim()) {
    return { kind: 'refused', message: `This reply wasn't sent: ${b.reason}` };
  }
  return { kind: 'refused', message: EXECUTE_REFUSAL_COPY[code] ?? EXECUTE_REFUSED_FALLBACK };
}

/** The execute route's 4xx codes (pages/api/community-ai/actions/execute.ts) as user copy. Nothing was sent. */
const EXECUTE_REFUSAL_COPY: Record<string, string> = {
  APPROVAL_REQUIRED: "This reply wasn't sent: it needs approval first.",
  TENANT_SCOPE_VIOLATION: "This reply wasn't sent: it doesn't belong to the selected company.",
  ACTION_NOT_FOUND: "This reply wasn't sent: it no longer exists. We refreshed the list.",
  PLAYBOOK_NOT_FOUND: "This reply wasn't sent: its playbook no longer exists.",
  PLAYBOOK_VIOLATION: "This reply wasn't sent: it breaks the playbook's rules.",
  FINAL_TEXT_REQUIRED: "This reply wasn't sent: the reply text is empty.",
};
export const EXECUTE_REFUSED_FALLBACK = "This reply wasn't sent.";

/** Thrown by the call sites for a classified outcome, so a catch can tell it from a request that never answered. */
export class ExecuteOutcomeError extends Error {}

/** For a catch block: a classified outcome keeps its sentence; anything else (the fetch itself threw) is unknown. */
export function executeErrorMessage(error: unknown): { message: string; reread: boolean } {
  if (error instanceof ExecuteOutcomeError) return { message: error.message, reread: false };
  return { message: EXECUTE_UNKNOWN, reread: true };
}
