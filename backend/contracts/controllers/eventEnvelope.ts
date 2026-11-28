/**
 * Versioned controller event envelope + runtime validator (Agent A, 2026-11-28;
 * hardened per coordinator review of b23bb8f9c).
 *
 * STRUCTURAL CONTRACT ONLY - no publisher, no bus, no persistence. A future
 * transport (see docs/adr/ADR-0002-event-envelope-and-delivery-semantics.md)
 * validates every envelope with `validateEventEnvelope` before it is accepted.
 *
 * What the envelope guarantees:
 *   - every event is scoped to BOTH a tenant and a company (no "global" events);
 *   - every event names the controller that produced it, and optionally the one
 *     it is addressed to;
 *   - correlation_id groups one business flow; causation_id names the event that
 *     caused this one (null only for a flow's root event);
 *   - the payload is scanned at every depth (`scanPayloadForCredentials`) and the
 *     event is REJECTED - never redacted - when the scan finds:
 *       * a credential-like KEY (rules in `isForbiddenPayloadKey`, matched after
 *         NFKC normalisation and case folding; any key still non-ASCII after NFKC
 *         is rejected outright, which closes homoglyph spellings);
 *       * an obvious credential VALUE (`credentialValueKind`: Bearer header values,
 *         three-part eyJ JWTs, PEM private keys, a fixed list of provider key
 *         prefixes). This is a CONSERVATIVE value scan: it does not detect an
 *         arbitrary random string that happens to be a secret;
 *       * a RESERVED own key - "__proto__", "constructor" or "prototype" - at any
 *         level of the envelope (see RESERVED_OWN_KEYS);
 *       * a Proxy (never inspected), a symbol key, an accessor (getter/setter)
 *         property, a non-plain object, a function/symbol/bigint value, a true
 *         cycle (a shared, non-cyclic reference is fine), or a payload too deep /
 *         too large to finish scanning (an unfinished scan is a rejection).
 *     The input is copied ONCE into plain data; scan, schema parse and the returned
 *     envelope all use that copy, so what is scanned is exactly what is returned.
 *     Named properties on arrays and non-enumerable own properties are scanned too.
 *
 * The envelope is deliberately strict (unknown top-level keys and any top-level
 * symbol key are rejected), so a credential cannot ride beside the payload either.
 * `validateEventEnvelope` never throws.
 *
 * Catalogue membership, producer/consumer and business rules are checked by
 * `checkEventPublication` in eventCatalogue.ts; this module checks shape only.
 */
import { types as utilTypes } from 'util';
import { z } from 'zod';
import { isSecretKeyName } from '../../security/logRedaction';
import { CONTROLLER_IDS } from './controllerIds';

export const ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Bounded payload walk: deeper than this is rejected (fail closed), never skipped. */
export const MAX_PAYLOAD_DEPTH = 12;
/** Bounded payload walk: more nodes than this is rejected (fail closed). */
export const MAX_PAYLOAD_NODES = 5000;
/** A string value longer than this cannot be fully value-scanned and is rejected. */
export const MAX_SCANNED_STRING_LENGTH = 65536;

/**
 * Fragments that mark a key as credential-bearing when they appear ANYWHERE in the
 * folded key (lowercase ASCII alphanumerics after NFKC). No descriptive-suffix
 * carve-out applies to these: `token_source`, `password_hint`, `secret_name`,
 * `api_key_id` are all rejected. An event payload has no business naming any of
 * them; ids belong in the owning store.
 */
export const FORBIDDEN_PAYLOAD_KEY_FRAGMENTS = [
  'token', // covers access/refresh/id/bearer/session/auth tokens, `tokens`, `tokenSource`
  'jwt',
  'bearer',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'authorization',
  'authheader',
  'cookie',
  'privatekey',
  'signingkey',
  'sessionkey',
  'onetimepassword',
] as const;

/**
 * Whole-word credential names, matched against the key's word segments
 * (snake/kebab/camel split) rather than as substrings, because the letters are
 * common inside ordinary words (`footprint` contains "otp").
 */
export const FORBIDDEN_PAYLOAD_KEY_WORDS = ['otp', 'totp', 'hotp', 'pwd', 'auth', 'sid'] as const;

/**
 * SESSION, decided precisely: an UNQUALIFIED session identifier is the web/auth
 * session handle and is a credential, so the exact keys `session`, `session_id`,
 * `sessionId`, `sid` are rejected (plus anything with session+token/key/cookie/
 * secret via the fragments above). An ENTITY-QUALIFIED session id such as
 * `voice_session_id` names a domain record (a voice session), not an auth
 * session, and is allowed.
 */
export const FORBIDDEN_EXACT_PAYLOAD_KEYS = ['session', 'sessionid'] as const;

/**
 * LLM usage counters that contain "token" but are not credentials. EXACT folded
 * keys only - `tokens`, `token_count`, `prompt_tokens_raw` are NOT exempt.
 */
export const LLM_USAGE_KEY_EXEMPTIONS = [
  'prompttokens',
  'completiontokens',
  'totaltokens',
  'inputtokens',
  'outputtokens',
  'maxtokens',
  'cachedtokens',
  'reasoningtokens',
] as const;

/** NFKC + case fold. Returns null when the key is still non-ASCII afterwards (homoglyph risk). */
function foldKey(key: string): string | null {
  const nfkc = key.normalize('NFKC');
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(nfkc)) return null;
  return nfkc;
}

function keyWords(asciiKey: string): string[] {
  return asciiKey
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Own keys rejected anywhere in an envelope. "__proto__" is the dangerous one: a
 * JSON.parse'd {"__proto__": {...}} is an OWN data property, and any copy made by
 * plain assignment turns it into the copy's prototype, so data hidden under it
 * would be read through inheritance (e.g. a payload that exists only there).
 * "constructor" and "prototype" are rejected too for consistency: they are never a
 * legitimate event field, and code downstream commonly treats them specially. The
 * snapshot additionally copies with Object.defineProperty, so even an unlisted key
 * can never reach a prototype slot.
 */
export const RESERVED_OWN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

export function isReservedOwnKey(key: string): boolean {
  return (RESERVED_OWN_KEYS as readonly string[]).includes(key);
}

export type ForbiddenKeyReason = 'non_ascii_key' | 'credential_key';

/** Why a payload key is forbidden, or null when it is allowed. */
export function forbiddenPayloadKeyReason(key: string): ForbiddenKeyReason | null {
  const ascii = foldKey(key);
  if (ascii === null) return 'non_ascii_key';
  const folded = ascii.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!folded) return null;
  if ((LLM_USAGE_KEY_EXEMPTIONS as readonly string[]).includes(folded)) return null;
  if ((FORBIDDEN_EXACT_PAYLOAD_KEYS as readonly string[]).includes(folded)) return 'credential_key';
  if (FORBIDDEN_PAYLOAD_KEY_FRAGMENTS.some((f) => folded.includes(f))) return 'credential_key';
  const words = keyWords(ascii);
  if (words.some((w) => (FORBIDDEN_PAYLOAD_KEY_WORDS as readonly string[]).includes(w))) return 'credential_key';
  if (isSecretKeyName(ascii)) return 'credential_key';
  return null;
}

/** True when an event payload key would (or could) hold a credential. */
export function isForbiddenPayloadKey(key: string): boolean {
  return forbiddenPayloadKeyReason(key) !== null;
}

/**
 * Obvious credential value shapes. Conservative by design (low false-positive):
 * each rule is anchored on a literal prefix and needs a minimum body length.
 */
const CREDENTIAL_VALUE_RULES: readonly { id: string; re: RegExp }[] = [
  { id: 'bearer', re: /\bbearer\s+[A-Za-z0-9\-._~+/]{8,}=*/i },
  { id: 'basic_auth', re: /\bbasic\s+[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/=])/i },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/ },
  { id: 'private_key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { id: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { id: 'openai_key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/ },
  { id: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { id: 'webhook_secret', re: /\bwhsec_[A-Za-z0-9+/=]{16,}/ },
  { id: 'supabase_key', re: /\b(?:sb_secret_|sbp_)[A-Za-z0-9_-]{16,}/ },
  { id: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: 'google_oauth_secret', re: /\bGOCSPX-[A-Za-z0-9_-]{16,}/ },
  { id: 'google_oauth_access_token', re: /\bya29\.[A-Za-z0-9_-]{20,}/ },
];

/** The id of the first credential shape found in a string value, or null. */
export function credentialValueKind(value: string): string | null {
  const v = value.normalize('NFKC');
  for (const rule of CREDENTIAL_VALUE_RULES) if (rule.re.test(v)) return rule.id;
  return null;
}

export type PayloadScanFinding =
  | { kind: 'forbidden_key'; path: string }
  | { kind: 'non_ascii_key'; path: string }
  | { kind: 'symbol_key'; path: string }
  | { kind: 'accessor_property'; path: string }
  | { kind: 'credential_value'; path: string; shape: string }
  | { kind: 'value_too_long'; path: string }
  | { kind: 'too_deep'; path: string }
  | { kind: 'too_many_nodes'; path: string }
  | { kind: 'circular'; path: string }
  | { kind: 'non_plain_value'; path: string }
  | { kind: 'proxy'; path: string }
  | { kind: 'reserved_key'; path: string }
  | { kind: 'scan_error'; path: string };

/** Render any property key safely (symbols included) - never throws. */
export function describeKey(key: PropertyKey): string {
  if (typeof key === 'symbol') return `[symbol ${key.description ?? ''}]`;
  return String(key);
}

/**
 * Walk a payload and report every credential-like key or value, plus any reason
 * the walk could not finish. Never throws; never invokes a getter.
 */
export function scanPayloadForCredentials(payload: unknown): PayloadScanFinding[] {
  const findings: PayloadScanFinding[] = [];
  /** Objects on the CURRENT path only: a shared reference ({x: s, y: s}) is not a cycle. */
  const ancestors = new Set<object>();
  let nodes = 0;

  const walk = (value: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) {
      if (!findings.some((f) => f.kind === 'too_many_nodes')) findings.push({ kind: 'too_many_nodes', path });
      return;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_SCANNED_STRING_LENGTH) {
        findings.push({ kind: 'value_too_long', path });
        return;
      }
      const shape = credentialValueKind(value);
      if (shape) findings.push({ kind: 'credential_value', path, shape });
      return;
    }
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        findings.push({ kind: 'non_plain_value', path });
      }
      return;
    }
    if (depth > MAX_PAYLOAD_DEPTH) {
      findings.push({ kind: 'too_deep', path });
      return;
    }
    // A Proxy can answer each read differently; it is never inspected (no trap is run).
    if (utilTypes.isProxy(value)) {
      findings.push({ kind: 'proxy', path });
      return;
    }
    if (ancestors.has(value)) {
      findings.push({ kind: 'circular', path });
      return;
    }
    const isArray = Array.isArray(value);
    if (!isArray) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        findings.push({ kind: 'non_plain_value', path });
        return;
      }
    }
    ancestors.add(value);
    try {
      walkChildren(value, isArray, path, depth);
    } finally {
      ancestors.delete(value);
    }
  };

  const walkChildren = (value: object, isArray: boolean, path: string, depth: number): void => {
    // Reflect.ownKeys: string + symbol keys, enumerable or not, incl. named props on arrays.
    for (const key of Reflect.ownKeys(value)) {
      if (isArray && key === 'length') continue;
      const childPath = isArray && typeof key === 'string' && /^\d+$/.test(key) ? `${path}[${key}]` : `${path}.${describeKey(key)}`;
      if (typeof key === 'symbol') {
        findings.push({ kind: 'symbol_key', path: childPath });
        continue;
      }
      if (isReservedOwnKey(key)) {
        findings.push({ kind: 'reserved_key', path: childPath });
        continue;
      }
      const isIndex = isArray && /^\d+$/.test(key);
      if (!isIndex) {
        const reason = forbiddenPayloadKeyReason(key);
        if (reason === 'non_ascii_key') findings.push({ kind: 'non_ascii_key', path: childPath });
        else if (reason) findings.push({ kind: 'forbidden_key', path: childPath });
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc) continue;
      if (desc.get || desc.set) {
        findings.push({ kind: 'accessor_property', path: childPath });
        continue;
      }
      walk(desc.value, childPath, depth + 1);
    }
  };

  try {
    walk(payload, 'payload', 0);
  } catch {
    findings.push({ kind: 'scan_error', path: 'payload' });
  }
  return findings;
}

const IdString = z
  .string()
  .max(200)
  .refine((s) => s.trim().length > 0 && s.trim() === s, 'must be a non-empty id without surrounding whitespace');

const EventTypeString = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{2,79}$/, 'event_type must be a catalogue name');

export const ControllerIdSchema = z.enum(CONTROLLER_IDS);

/** Shape of every controller event. `payload` is validated per event type by the catalogue. */
export const EventEnvelopeSchema = z.strictObject({
  event_id: z.uuid(),
  event_type: EventTypeString,
  event_version: z.number().int().min(1),
  tenant_id: IdString,
  company_id: IdString,
  source_controller: ControllerIdSchema,
  target_controller: ControllerIdSchema.optional(),
  correlation_id: IdString,
  /** null only for the root event of a flow. */
  causation_id: IdString.nullable(),
  entity_type: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'entity_type must be snake_case'),
  entity_id: IdString,
  occurred_at: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope<P extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof EventEnvelopeSchema>,
  'payload'
> & { payload: P };

export type EnvelopeValidationResult =
  | { ok: true; envelope: EventEnvelope; errors: [] }
  | { ok: false; errors: string[] };

/** Join an issue path whose segments may be symbols - never throws. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.map(describeKey).join('.') || '(envelope)';
}

/** Findings that make the input unsafe to treat as plain data. */
const STRUCTURAL_HAZARDS = new Set<PayloadScanFinding['kind']>([
  'symbol_key', 'accessor_property', 'circular', 'non_plain_value', 'too_deep', 'too_many_nodes', 'scan_error', 'proxy', 'reserved_key',
]);

type Snapshot = { value: unknown; hazards: PayloadScanFinding[] };

/**
 * Copy the input ONCE into fresh plain data (own data properties only, read via
 * descriptors - no getter or Proxy trap is ever run). Everything after this -
 * credential scan, schema parse, the returned envelope - works on the copy, so
 * what is scanned is exactly what is returned (no read-twice / TOCTOU gap).
 * Non-enumerable own properties and named array properties are copied as ordinary
 * properties so the scan and the strict schemas see them.
 */
function snapshotPlainData(raw: unknown): Snapshot {
  const hazards: PayloadScanFinding[] = [];
  const ancestors = new Set<object>();
  let nodes = 0;
  // +1: the envelope itself sits one level above the payload.
  const maxDepth = MAX_PAYLOAD_DEPTH + 1;

  const copy = (value: unknown, path: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES + 64) {
      if (!hazards.some((h) => h.kind === 'too_many_nodes')) hazards.push({ kind: 'too_many_nodes', path });
      return undefined;
    }
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        hazards.push({ kind: 'non_plain_value', path });
        return undefined;
      }
      return value;
    }
    if (utilTypes.isProxy(value)) {
      hazards.push({ kind: 'proxy', path });
      return undefined;
    }
    if (depth > maxDepth) {
      hazards.push({ kind: 'too_deep', path });
      return undefined;
    }
    if (ancestors.has(value)) {
      hazards.push({ kind: 'circular', path });
      return undefined;
    }
    const isArray = Array.isArray(value);
    if (!isArray) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        hazards.push({ kind: 'non_plain_value', path });
        return undefined;
      }
    }
    ancestors.add(value);
    try {
      const out: Record<string, unknown> | unknown[] = isArray ? [] : {};
      for (const key of Reflect.ownKeys(value)) {
        if (isArray && key === 'length') continue;
        const childPath = `${path}.${describeKey(key)}`;
        if (typeof key === 'symbol') {
          hazards.push({ kind: 'symbol_key', path: childPath });
          continue;
        }
        if (isReservedOwnKey(key)) {
          hazards.push({ kind: 'reserved_key', path: childPath });
          continue;
        }
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc) continue;
        if (desc.get || desc.set) {
          hazards.push({ kind: 'accessor_property', path: childPath });
          continue;
        }
        // defineProperty, never assignment: a key can never land in a prototype slot.
        Object.defineProperty(out, key, {
          value: copy(desc.value, childPath, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  };

  try {
    const value = copy(raw, '(envelope)', 0);
    return { value, hazards };
  } catch {
    return { value: undefined, hazards: [...hazards, { kind: 'scan_error', path: '(envelope)' }] };
  }
}

function validateUnsafe(raw: unknown): EnvelopeValidationResult {
  const errors: string[] = [];
  // 1. One snapshot; nothing below reads `raw` again.
  const snap = snapshotPlainData(raw);
  for (const h of snap.hazards) errors.push(`${h.path}: ${h.kind}`);
  if (snap.hazards.some((h) => STRUCTURAL_HAZARDS.has(h.kind))) return { ok: false, errors };
  const data = snap.value;
  // 2. Credential scan of the snapshot's payload (even if the shape is invalid).
  if (data !== null && typeof data === 'object' && !Array.isArray(data) && 'payload' in data) {
    for (const f of scanPayloadForCredentials((data as Record<string, unknown>).payload)) {
      errors.push(`${f.path}: ${f.kind}${f.kind === 'credential_value' ? ` (${f.shape})` : ''}`);
    }
  }
  // 3. Shape of the snapshot; the returned envelope is built from the snapshot only.
  const parsed = EventEnvelopeSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${formatIssuePath(issue.path as PropertyKey[])}: ${String(issue.message)}`);
    }
  }
  if (errors.length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, envelope: parsed.data as EventEnvelope, errors: [] };
}

/**
 * Validate an envelope's shape and scan its payload for credentials. NEVER throws:
 * any unexpected failure inside validation is itself a rejection.
 * The credential scan runs even when the shape is invalid, so a malformed
 * envelope that also carries a token reports both.
 */
export function validateEventEnvelope(raw: unknown): EnvelopeValidationResult {
  try {
    return validateUnsafe(raw);
  } catch {
    return { ok: false, errors: ['(envelope): validator_error'] };
  }
}
