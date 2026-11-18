/**
 * Launch gate: WhatsApp stays unavailable until the stranded WhatsApp line (stage 3) is live (b3 ruling, 11-18).
 *
 * C114 (owner-approved prod read, 11-18): WhatsApp has never been used in production (0 sender accounts,
 * 0 broadcasts, 0 recipients, 0 templates, 0 inbound). Main's WhatsApp code lacks the line's
 * correct-sending fixes (STOP opt-out, send claim, unconfirmed-send handling, quota), so it must not
 * become usable before that stage lands.
 *
 * DEFAULT OFF, STRICT: only the exact string 'true' enables it. Anything else ('1', 'TRUE', ' true',
 * unset) is off. The flag is turned on only after stage 3's presence check, with owner approval.
 *
 * Kept deliberately tiny so it rebases trivially under stage 3.
 */
import type { NextApiResponse } from 'next';

export const WHATSAPP_NOT_AVAILABLE = 'WHATSAPP_NOT_AVAILABLE';

/** True only when WHATSAPP_CONNECT_ENABLED is exactly 'true'. Read on every call (no caching). */
export function isWhatsAppEnabled(): boolean {
  return process.env.WHATSAPP_CONNECT_ENABLED === 'true';
}

/** The refusal body every gated route answers with. Not retryable: retrying cannot change the answer. */
export function whatsAppNotAvailableBody() {
  return {
    error: 'WhatsApp is not available yet.',
    code: WHATSAPP_NOT_AVAILABLE,
    retryable: false,
  } as const;
}

/**
 * Answers 409 WHATSAPP_NOT_AVAILABLE and returns true when WhatsApp is disabled; returns false
 * (and writes nothing) when it is enabled. Call it FIRST in a gated branch, before any read or write.
 */
export function refuseIfWhatsAppDisabled(res: NextApiResponse): boolean {
  if (isWhatsAppEnabled()) return false;
  res.status(409).json(whatsAppNotAvailableBody());
  return true;
}

/** Thrown by the service-layer send seams (belt and braces under the routes). */
export class WhatsAppNotAvailableError extends Error {
  readonly code = WHATSAPP_NOT_AVAILABLE;
  readonly retryable = false;
  constructor() {
    super('WhatsApp is not available yet');
    this.name = 'WhatsAppNotAvailableError';
  }
}

/** Service-layer guard: throws WhatsAppNotAvailableError when disabled. */
export function assertWhatsAppEnabled(): void {
  if (!isWhatsAppEnabled()) throw new WhatsAppNotAvailableError();
}
