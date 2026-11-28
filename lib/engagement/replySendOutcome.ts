/**
 * E3 (register row T-2) — client side of stable reply idempotency.
 *
 * 1. One client key per composed reply. `ReplyKeyHolder.keyFor(basis)` returns
 *    the same key for the same (target + normalised draft text) until the reply
 *    succeeds (`reset()`) or the user changes target/text (a new basis → a new
 *    key). A network error, a timeout or an "outcome unknown" answer keep it,
 *    so a resend of the same reply carries the same key and the server answers
 *    from the stored action instead of sending again.
 * 2. `classifyReplySendResponse` decides what the composer may SAY. Anything
 *    the server could have executed (no response, a non-JSON gateway error, a
 *    500, an explicit unknown/in-progress code) is "status unknown — check
 *    before resending", never "failed, try again".
 */

export const REPLY_STATUS_UNKNOWN_MESSAGE = 'Sending status unknown — check the conversation before resending.';

export function normalizeDraftForKey(text: string): string {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function newClientReplyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ReplyKeyHolder {
  private basis: string | null = null;
  private key: string | null = null;

  keyFor(parts: { threadId: string; messageId: string; platform: string; text: string }): string {
    const basis = JSON.stringify([parts.threadId, parts.messageId, parts.platform, normalizeDraftForKey(parts.text)]);
    if (this.key && this.basis === basis) return this.key;
    this.basis = basis;
    this.key = newClientReplyKey();
    return this.key;
  }

  /** The reply succeeded or was discarded: the next reply is a new logical reply. */
  reset(): void {
    this.basis = null;
    this.key = null;
  }
}

export type ReplySendClassification =
  | { kind: 'sent'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'not_sent'; message: string };

type ReplyJson = {
  error?: unknown;
  code?: unknown;
  status?: unknown;
  outcome?: unknown;
  success?: unknown;
  confirmed?: unknown;
  platform_id?: unknown;
  already_sent?: unknown;
  retryable?: unknown;
};

/** Lead with the unknown-status sentence exactly once. */
const withUnknownLead = (detail: string | null): string => {
  if (!detail) return REPLY_STATUS_UNKNOWN_MESSAGE;
  return /^Sending status unknown/i.test(detail) ? detail : `${REPLY_STATUS_UNKNOWN_MESSAGE} ${detail}`;
};

const UNKNOWN_CODES = new Set(['REPLY_OUTCOME_UNKNOWN', 'REPLY_IN_PROGRESS', 'REPLY_PRIOR_ATTEMPT_FAILED']);

export function classifyReplySendResponse(input: {
  networkError?: boolean;
  httpStatus?: number;
  json?: ReplyJson | null;
  platform: string;
}): ReplySendClassification {
  if (input.networkError) return { kind: 'unknown', message: REPLY_STATUS_UNKNOWN_MESSAGE };
  const status = Number(input.httpStatus ?? 0);
  const json = input.json ?? null;
  const serverMessage = typeof json?.error === 'string' && json.error ? json.error : null;
  if (status >= 200 && status < 300 && json && json.success === true && json.status === 'executed') {
    if (json.already_sent === true) {
      return { kind: 'sent', message: `This reply was already sent to ${input.platform}; it was not sent again.` };
    }
    if (json.confirmed === true && typeof json.platform_id === 'string' && json.platform_id) {
      return { kind: 'sent', message: `Reply confirmed by ${input.platform} (id: ${json.platform_id}).` };
    }
    return { kind: 'sent', message: `Reply sent to ${input.platform}. Awaiting platform confirmation.` };
  }
  if (status === 202 && json && json.status === 'queued') {
    const queuedMessage = typeof (json as { message?: unknown }).message === 'string' ? String((json as { message?: unknown }).message) : '';
    return { kind: 'unknown', message: withUnknownLead(queuedMessage || 'The reply is queued for the Omnivyra extension and not yet confirmed.') };
  }
  if (json && (UNKNOWN_CODES.has(String(json.code ?? '')) || json.outcome === 'unknown')) {
    return { kind: 'unknown', message: withUnknownLead(serverMessage) };
  }
  // A definite pre-send refusal from OUR server: a JSON body with a 4xx, or a 503/502 that says it never sent.
  const definiteRefusal =
    json !== null
    && ((status >= 400 && status < 500)
      || (status === 503 && json.retryable === true)
      || (status === 502 && json.outcome === 'not_sent'));
  if (definiteRefusal) {
    return { kind: 'not_sent', message: serverMessage ?? 'The reply was not sent.' };
  }
  // 2xx that is not an executed send (e.g. queued without an extension), 500, gateway errors, non-JSON bodies:
  // the server may have executed — never invite a blind resend.
  return { kind: 'unknown', message: withUnknownLead(serverMessage) };
}

/**
 * The message a reply surface shows for a NON-2xx answer (or no answer at all):
 * the shared "status unknown" copy whenever the server could have executed,
 * the server's explicit reason for a definite pre-send refusal.
 */
export function replyFailureMessage(input: { networkError?: boolean; httpStatus?: number; json?: Record<string, unknown> | null; platform: string }, fallback = 'Reply failed'): { unknown: boolean; message: string } {
  const outcome = classifyReplySendResponse(input as Parameters<typeof classifyReplySendResponse>[0]);
  if (outcome.kind === 'unknown') return { unknown: true, message: outcome.message };
  const serverError = typeof input.json?.error === 'string' && input.json.error ? String(input.json.error) : null;
  return { unknown: false, message: serverError ?? fallback };
}

/** For errors thrown by an injected executor (onExecuteReply): a fetch network failure / abort / timeout is unknown. */
export function isUnknownOutcomeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = String((err as { name?: unknown }).name ?? '');
  const message = String((err as { message?: unknown }).message ?? '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (name === 'TypeError' && /fetch|network|load failed/i.test(message)) return true;
  return /Sending status unknown|outcome is not yet known|may have reached the platform/i.test(message);
}
