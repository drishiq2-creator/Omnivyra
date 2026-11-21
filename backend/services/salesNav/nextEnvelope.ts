/**
 * The SIGNED /next 'read' answer (7c via a9, 2026-11-21). The request to /next is HMAC-signed by the extension; its
 * ANSWER is signed here, with the SAME per-session secret (extensionSessionService.deriveExtensionHmacSecret), under a
 * DISTINCT domain string so a v15 command signature can never be replayed as a /next answer, and vice versa.
 *
 *   envelope_signature = hex HMAC-SHA256(secret, SALESNAV_NEXT_DOMAIN + "\n" + canonical(envelope))
 *
 * The extension verifies it in constant time and refuses on mismatch (/close failed internal_error); it also refuses an
 * expired envelope and any page_index not STRICTLY greater than the last it accepted for the run (no replayed page).
 *
 * canonical(): a VERBATIM copy of lib/extension/envelope.ts:42 on the stranded line (fix/s-wa-combined @ 409764959),
 * which is not on main yet. It is pinned to that file's own `canonical_basic` vector below. REGISTERED FOLLOW-UP (c6):
 * when stage 0 lands, import canonical from lib/extension/envelope.ts and delete this copy - one implementation.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const SALESNAV_NEXT_DOMAIN = 'omnivyra.salesnav.next.v1';
/** How long a signed /next answer stays valid. */
export const SALESNAV_NEXT_TTL_SECONDS = 60;

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, undefined-valued keys
 * omitted, no whitespace; arrays in order; scalars via JSON.stringify.
 *
 * NAMED REWRITE of the copied original (a9 + c6, 2026-11-21: "make it impossible rather than pick a side"). The
 * original rendered an undefined/missing ARRAY element as an empty slot ("[1,]", not JSON) and silently dropped
 * unsupported types (a function stringifies to undefined); the extension's port emitted 'null' / threw. Both sides
 * now THROW on (a) an undefined or missing (sparse) array element and (b) any value that is not null / boolean /
 * string / finite number / array / plain object. Every input the two sides accept therefore yields the same bytes.
 * The stranded-line lib/extension/envelope.ts gets the same change after the stage-0 merge (a9's named follow-up)
 * - only then may this copy be replaced by the import.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonical: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (let i = 0; i < v.length; i += 1) {
      // a loop, not map(): map() skips the holes of a sparse array, which would render as empty slots
      if (!(i in v) || v[i] === undefined) throw new Error('canonical: undefined array element');
      parts.push(canonical(v[i]));
    }
    return `[${parts.join(',')}]`;
  }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error('canonical: unsupported object type');
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  throw new Error(`canonical: unsupported type ${typeof v}`);
}

export interface SalesNavNextEnvelope {
  readonly run_id: string;
  readonly page_index: number;
  readonly page_url: string;
  readonly position: { readonly param: 'page'; readonly value: string };
  readonly max_leads: number;
  /** The bound member as urn:li:fsd_profile:<id>. */
  readonly member: string;
  /** ISO instant; the extension refuses the answer after it. */
  readonly expires_at: string;
}

export function signNextEnvelope(envelope: SalesNavNextEnvelope, hmacSecret: string): string {
  if (!hmacSecret) throw new Error('signNextEnvelope: missing secret');
  return createHmac('sha256', hmacSecret).update(`${SALESNAV_NEXT_DOMAIN}\n${canonical(envelope)}`).digest('hex');
}

/** Constant-time verification (server tests; the extension has its own copy, pinned to the same vectors). */
export function verifyNextEnvelope(envelope: SalesNavNextEnvelope, signature: string, hmacSecret: string): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signNextEnvelope(envelope, hmacSecret), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
