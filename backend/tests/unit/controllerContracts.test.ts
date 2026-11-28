/**
 * Controller foundation contracts (Agent A, 2026-11-28).
 *
 * Every REJECTING assertion is paired with an ACCEPTING control built from the
 * same fixture with only the one field changed, so a suite that rejected
 * everything (or accepted everything) fails here instead of passing vacuously.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  CONTROLLER_IDS,
  CONTROLLER_REGISTER,
  COMPLETED_OUTCOMES,
  EVENT_CATALOGUE,
  EXECUTION_OUTCOMES,
  FAILED_OUTCOMES,
  UNKNOWN_OUTCOMES,
  UNKNOWN_OUTCOME_EVENT,
  VOICE_UNKNOWN_OUTCOME_EVENT,
  credentialValueKind,
  outcomeOptions,
  SHARED_SERVICE_IDS,
  SHARED_SERVICE_OWNERS,
  SHARED_SERVICE_REGISTER,
  catalogueIntegrityViolations,
  checkEventPublication,
  eventsConsumedBy,
  eventsPublishedBy,
  findByProgrammeName,
  isForbiddenPayloadKey,
  scanPayloadForCredentials,
  validateEventEnvelope,
  type CatalogueEntry,
  type ControllerId,
} from '../../contracts/controllers';
import { LISTENING_EVENT_TYPES } from '../../events/listeningEventsCore';

const REPO_ROOT = join(__dirname, '..', '..', '..');

const PROGRAMME_EVENTS = [
  'ProspectSignalDetected', 'MarketSignalDetected', 'ProspectEnrichmentRequested', 'ProspectEnrichmentCompleted',
  'ProspectQualificationRequested', 'ProspectQualificationCompleted', 'LeadReviewRequested', 'LeadApproved',
  'LeadRejected', 'LeadAddedToList', 'EngagementDetected', 'EngagementClassified', 'ResponseRecommendationCreated',
  'CampaignExecutionRequested', 'ChannelExecutionRequested', 'ExecutionCompleted', 'ExecutionFailed',
  'InboundResponseReceived', 'NextBestActionRecommended', 'VoiceSessionRequested', 'VoiceSessionStarted',
  'VoiceSessionCompleted', 'VoiceSessionFailed',
  // added by coordinator decision (review of b23bb8f9c): unknown travels only in its own event
  'ExecutionOutcomeUnknown',
  // coordinator decision 2026-11-28: voice mirrors it
  'VoiceSessionOutcomeUnknown',
];

function entry(name: string): CatalogueEntry {
  const e = findByProgrammeName(name);
  if (!e) throw new Error(`fixture: ${name} missing from catalogue`);
  return e;
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    event_type: 'EngagementDetected',
    event_version: 1,
    tenant_id: 'tenant-1',
    company_id: 'company-1',
    source_controller: 'engagement_intelligence',
    correlation_id: 'corr-1',
    causation_id: null,
    entity_type: 'engagement_thread',
    entity_id: 'thread-1',
    occurred_at: '2026-11-28T10:00:00.000Z',
    payload: { thread_id: 'thread-1', message_id: null, platform: 'linkedin' },
    ...overrides,
  };
}

/** A publication-valid envelope for the named event, from the given producer. */
function publication(name: string, source: ControllerId, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const e = entry(name);
  return envelope({
    event_type: e.event_type,
    event_version: e.event_version,
    source_controller: source,
    entity_type: e.entity_type,
    payload,
    ...extra,
  });
}

const APPROVER = '6f1c3a52-8f6e-4b7a-9d0e-2b6f9a1c4d3e';
const approvedPayload = () => ({
  lead_id: 'lead-1',
  approver_kind: 'human',
  approver_user_id: APPROVER,
  decided_at: '2026-11-28T10:00:00Z',
});

describe('event envelope', () => {
  it('accepts a complete envelope (control)', () => {
    const r = validateEventEnvelope(envelope());
    expect(r.ok).toBe(true);
  });

  it.each(['tenant_id', 'company_id'])('rejects an envelope without %s', (field) => {
    const bad = envelope();
    delete bad[field];
    expect(validateEventEnvelope(bad).ok).toBe(false);
    expect(validateEventEnvelope(envelope()).ok).toBe(true);
  });

  it.each(['tenant_id', 'company_id'])('rejects a blank or padded %s', (field) => {
    expect(validateEventEnvelope(envelope({ [field]: '' })).ok).toBe(false);
    expect(validateEventEnvelope(envelope({ [field]: '   ' })).ok).toBe(false);
    expect(validateEventEnvelope(envelope({ [field]: ' x ' })).ok).toBe(false);
    expect(validateEventEnvelope(envelope({ [field]: 'x' })).ok).toBe(true);
  });

  it.each([
    ['event_id', 'not-a-uuid'],
    ['event_version', 0],
    ['event_version', 1.5],
    ['source_controller', 'billing'],
    ['target_controller', 'billing'],
    ['occurred_at', '2026-11-28 10:00'],
    ['entity_type', 'Engagement Thread'],
    ['causation_id', ''],
    ['payload', 'a string'],
    ['payload', ['array']],
  ])('rejects %s = %p', (field, value) => {
    expect(validateEventEnvelope(envelope({ [field]: value })).ok).toBe(false);
  });

  it('accepts the optional fields in their valid forms (controls for the table above)', () => {
    expect(validateEventEnvelope(envelope({ target_controller: 'lead_intelligence' })).ok).toBe(true);
    expect(validateEventEnvelope(envelope({ causation_id: 'evt-0' })).ok).toBe(true);
    expect(validateEventEnvelope(envelope({ occurred_at: '2026-11-28T15:30:00+05:30' })).ok).toBe(true);
    expect(validateEventEnvelope(envelope({ event_version: 2 })).ok).toBe(true);
  });

  it('rejects unknown top-level keys (a credential cannot ride beside the payload)', () => {
    expect(validateEventEnvelope(envelope({ access_token: 'x' })).ok).toBe(false);
    expect(validateEventEnvelope(envelope({ trace: 'x' })).ok).toBe(false);
    expect(validateEventEnvelope(envelope()).ok).toBe(true);
  });

  it.each([null, undefined, 42, 'str', []])('never throws and rejects non-object input %p', (raw) => {
    expect(() => validateEventEnvelope(raw)).not.toThrow();
    expect(validateEventEnvelope(raw).ok).toBe(false);
  });
});

describe('credential-like payload keys', () => {
  const REQUIRED = ['access_token', 'refresh_token', 'password', 'secret', 'api_key', 'authorization', 'cookie'];
  const variants = (k: string) => [k, k.toUpperCase(), k.replace(/_/g, ''), k.replace(/_(.)/g, (_, c: string) => c.toUpperCase()), `x_${k}`, `${k}_value`];

  it.each(REQUIRED)('rejects %s (every case / separator variant) at the top of the payload', (key) => {
    for (const k of variants(key)) {
      const r = validateEventEnvelope(envelope({ payload: { thread_id: 't', [k]: 'v' } }));
      expect({ k, ok: r.ok }).toEqual({ k, ok: false });
    }
  });

  it.each(REQUIRED)('rejects %s nested in objects and arrays', (key) => {
    const nestedObj = { thread_id: 't', meta: { provider: { [key.toUpperCase()]: 'v' } } };
    const nestedArr = { thread_id: 't', items: [{ ok: 1 }, { deeper: [{ [key]: 'v' }] }] };
    expect(validateEventEnvelope(envelope({ payload: nestedObj })).ok).toBe(false);
    expect(validateEventEnvelope(envelope({ payload: nestedArr })).ok).toBe(false);
  });

  it('accepts the same nesting with harmless keys (control)', () => {
    const nestedObj = { thread_id: 't', meta: { provider: { name: 'v' } } };
    const nestedArr = { thread_id: 't', items: [{ ok: 1 }, { deeper: [{ label: 'v' }] }] };
    expect(validateEventEnvelope(envelope({ payload: nestedObj })).ok).toBe(true);
    expect(validateEventEnvelope(envelope({ payload: nestedArr })).ok).toBe(true);
  });

  it('rejects a credential key even when its value is empty or null', () => {
    expect(validateEventEnvelope(envelope({ payload: { password: '' } })).ok).toBe(false);
    expect(validateEventEnvelope(envelope({ payload: { Authorization: null } })).ok).toBe(false);
  });

  it('keeps ordinary id/count keys (controls for the key rule)', () => {
    for (const k of ['thread_id', 'max_tokens', 'prompt_tokens', 'lead_id', 'provider', 'platform', 'outcome', 'voice_session_id']) {
      expect({ k, forbidden: isForbiddenPayloadKey(k) }).toEqual({ k, forbidden: false });
    }
    for (const k of ['access_token', 'clientSecret', 'X-Api-Key', 'Set-Cookie', 'sessionCookie', 'token_count']) {
      expect({ k, forbidden: isForbiddenPayloadKey(k) }).toEqual({ k, forbidden: true });
    }
  });

  it('fails closed on a circular or over-deep payload', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(validateEventEnvelope(envelope({ payload: circular })).ok).toBe(false);
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(validateEventEnvelope(envelope({ payload: deep })).ok).toBe(false);
    let shallow: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 5; i++) shallow = { n: shallow };
    expect(validateEventEnvelope(envelope({ payload: shallow })).ok).toBe(true);
  });
});

describe('hardening (coordinator review of b23bb8f9c)', () => {
  const ok = () => envelope();
  const withPayload = (payload: unknown) => envelope({ payload });

  it('never throws on a symbol key, and rejects it (payload and top level)', () => {
    const sym = Symbol('k');
    const payloadSym = { thread_id: 't', message_id: null, platform: 'x', [sym]: 'v' } as Record<PropertyKey, unknown>;
    expect(() => validateEventEnvelope(withPayload(payloadSym))).not.toThrow();
    expect(validateEventEnvelope(withPayload(payloadSym)).ok).toBe(false);
    const nestedSym = { thread_id: 't', meta: { [sym]: 1 } };
    expect(validateEventEnvelope(withPayload(nestedSym)).ok).toBe(false);
    const top = { ...ok(), [sym]: 'v' };
    expect(() => validateEventEnvelope(top)).not.toThrow();
    expect(validateEventEnvelope(top).ok).toBe(false);
    expect(() => checkEventPublication(top)).not.toThrow();
    expect(checkEventPublication(top).ok).toBe(false);
    // control
    expect(validateEventEnvelope(ok()).ok).toBe(true);
  });

  it('never throws on a throwing getter, and rejects accessors without invoking them', () => {
    let invoked = false;
    const payload: Record<string, unknown> = { thread_id: 't' };
    Object.defineProperty(payload, 'label', { enumerable: true, get() { invoked = true; throw new Error('boom'); } });
    expect(() => validateEventEnvelope(withPayload(payload))).not.toThrow();
    expect(validateEventEnvelope(withPayload(payload)).ok).toBe(false);
    expect(invoked).toBe(false);
    const env = ok();
    Object.defineProperty(env, 'payload', { enumerable: true, get() { throw new Error('boom'); } });
    expect(() => validateEventEnvelope(env)).not.toThrow();
    expect(validateEventEnvelope(env).ok).toBe(false);
    expect(() => checkEventPublication(env)).not.toThrow();
  });

  const NEW_KEYS = [
    'tokens', 'token', 'jwt', 'id_jwt', 'bearer', 'authHeader', 'auth_header', 'auth',
    'session', 'session_id', 'sessionId', 'sid', 'session_token', 'sessionCookie', 'session_key',
    'signing_key', 'signingKey', 'otp', 'otp_code', 'totp', 'one_time_password',
    'tokenSource', 'token_source', 'token_type', 'secret_name', 'password_hint', 'api_key_id', 'token_count',
  ];
  it.each(NEW_KEYS)('rejects credential key %s', (k) => {
    expect(isForbiddenPayloadKey(k)).toBe(true);
    expect(validateEventEnvelope(withPayload({ thread_id: 't', [k]: 'v' })).ok).toBe(false);
  });

  const LOOKALIKES = ['ſecret', 'paſſword', '\uFF50\uFF41\uFF53\uFF53\uFF57\uFF4F\uFF52\uFF44', 'ＡＰＩ_ＫＥＹ', 'access_\uFF54oken', 'p\u0430ssword'];
  it.each(LOOKALIKES)('rejects Unicode lookalike key %p (NFKC + fold, non-ASCII rejected)', (k) => {
    expect(isForbiddenPayloadKey(k)).toBe(true);
    expect(validateEventEnvelope(withPayload({ thread_id: 't', [k]: 'v' })).ok).toBe(false);
  });

  const ALLOWED = ['thread_id', 'voice_session_id', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'max_tokens',
    'footprint', 'author_id', 'oauth_provider', 'lead_id', 'disposition_code', 'idempotency_key', 'requested_attributes'];
  it.each(ALLOWED)('accepts ordinary key %s (control)', (k) => {
    expect(isForbiddenPayloadKey(k)).toBe(false);
    expect(validateEventEnvelope(withPayload({ thread_id: 't', [k]: 'v' })).ok).toBe(true);
  });

  it('the LLM exemption is exact: near-miss usage keys are rejected', () => {
    for (const k of ['prompt_tokens', 'total_tokens']) expect(isForbiddenPayloadKey(k)).toBe(false);
    for (const k of ['prompt_tokens_raw', 'tokens_total', 'refresh_tokens', 'access_tokens']) expect({ k, f: isForbiddenPayloadKey(k) }).toEqual({ k, f: true });
  });

  it('scans named properties on arrays and non-enumerable own properties', () => {
    const arr = Object.assign(['a', 'b'], { access_token: 'v' });
    expect(validateEventEnvelope(withPayload({ items: arr })).ok).toBe(false);
    const hidden: Record<string, unknown> = { thread_id: 't' };
    Object.defineProperty(hidden, 'password', { value: 'v', enumerable: false });
    expect(validateEventEnvelope(withPayload(hidden)).ok).toBe(false);
    const hiddenNested: Record<string, unknown> = {};
    Object.defineProperty(hiddenNested, 'note', { value: 'Bearer abcdefghijklmnop', enumerable: false });
    expect(validateEventEnvelope(withPayload({ meta: hiddenNested })).ok).toBe(false);
    // controls
    expect(validateEventEnvelope(withPayload({ items: ['a', 'b'] })).ok).toBe(true);
    const hiddenOk: Record<string, unknown> = { thread_id: 't' };
    Object.defineProperty(hiddenOk, 'label', { value: 'fine', enumerable: false });
    expect(validateEventEnvelope(withPayload(hiddenOk)).ok).toBe(true);
  });

  const B = (n: number) => 'A'.repeat(n);
  const BAD_VALUES: [string, string][] = [
    ['bearer', 'Bearer abcdefghijklmnopqrstuvwxyz0123'],
    ['bearer', 'authorization: bearer abc.def-ghi_jkl'],
    // Synthetic placeholders assembled at runtime so no credential-shaped literal
    // appears in source (keeps gitleaks / check-secrets quiet; none is a real key).
    ['jwt', ['eyJ' + B(17), 'eyJ' + B(25), B(43)].join('.')],
    ['private_key', '-----BEGIN RSA ' + 'PRIVATE KEY-----\n' + B(4)],
    ['anthropic_key', 'sk-ant-' + B(24)],
    ['openai_key', 'sk-proj-' + B(30)],
    ['stripe_key', 'sk_live_' + B(24)],
    ['webhook_secret', 'whsec_' + B(24)],
    ['supabase_key', 'sb_secret_' + B(24)],
    ['aws_access_key', 'AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['github_token', 'ghp_' + B(36)],
    ['slack_token', 'xoxb-' + '1234567890-abcdef'],
    ['google_api_key', 'AIza' + B(35)],
    ['google_oauth_secret', 'GOCSPX-' + B(24)],
    ['google_oauth_access_token', 'ya29.' + 'a0AfH6SMBx' + B(30)],
  ];
  it.each(BAD_VALUES)('rejects a %s-shaped value, nested', (shape, value) => {
    expect(credentialValueKind(value)).toBe(shape);
    expect(validateEventEnvelope(withPayload({ thread_id: 't', meta: { list: [{ note: value }] } })).ok).toBe(false);
  });

  const GOOD_VALUES = ['linkedin', 'response_lost', '6f1c3a52-8f6e-4b7a-9d0e-2b6f9a1c4d3e', 'the bearer of good news',
    'task-abcdefghijklmnopqrstuvwxyz', 'eyJ-not-a-jwt', 'basic', 'skate', 'AKIA', '2026-11-28T10:00:00Z',
    'ya29', 'ya29.short', 'version ya29 notes', 'kya29.' + 'A'.repeat(30)];
  it.each(GOOD_VALUES)('accepts ordinary value %p (control)', (value) => {
    expect(credentialValueKind(value)).toBeNull();
    expect(validateEventEnvelope(withPayload({ thread_id: 't', note: value })).ok).toBe(true);
  });

  it('rejects an unscannably long string value (control: a normal string passes)', () => {
    expect(validateEventEnvelope(withPayload({ note: 'x'.repeat(70000) })).ok).toBe(false);
    expect(validateEventEnvelope(withPayload({ note: 'x'.repeat(1000) })).ok).toBe(true);
  });
});

describe('re-review of fcfdcd401: snapshot, proxies, shared references, pinned keys', () => {
  const plainPayload = () => ({ thread_id: 't', message_id: null, platform: 'linkedin' });

  it('rejects a Proxy whose get trap differs from its descriptor, without running any trap', () => {
    let trapCalls = 0;
    const target = plainPayload();
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(t, k) { trapCalls += 1; return k === 'platform' ? 'Bearer abcdefghijklmnopqrstuvwxyz' : Reflect.get(t, k); },
      getOwnPropertyDescriptor(t, k) { trapCalls += 1; return Reflect.getOwnPropertyDescriptor(t, k); },
      ownKeys(t) { trapCalls += 1; return Reflect.ownKeys(t); },
    };
    const proxied = new Proxy(target, handler);
    expect(validateEventEnvelope(envelope({ payload: proxied })).ok).toBe(false);
    expect(checkEventPublication(publication('EngagementDetected', 'engagement_intelligence', proxied as Record<string, unknown>)).ok).toBe(false);
    expect(scanPayloadForCredentials(proxied).map((f) => f.kind)).toContain('proxy');
    // proxy as the whole envelope and nested deep inside the payload
    expect(validateEventEnvelope(new Proxy(envelope(), {})).ok).toBe(false);
    expect(validateEventEnvelope(envelope({ payload: { meta: { inner: new Proxy({ a: 1 }, {}) } } })).ok).toBe(false);
    expect(trapCalls).toBe(0);
  });

  it('rejects a Proxy whose ownKeys changes between reads (TOCTOU), without running any trap', () => {
    let reads = 0;
    const target: Record<string, unknown> = plainPayload();
    const proxied = new Proxy(target, {
      ownKeys(t) { reads += 1; return reads === 1 ? Reflect.ownKeys(t) : [...Reflect.ownKeys(t), 'access_token']; },
      getOwnPropertyDescriptor(t, k) {
        return k === 'access_token' ? { value: 'secret-value', enumerable: true, configurable: true, writable: true } : Reflect.getOwnPropertyDescriptor(t, k);
      },
      get(t, k) { return k === 'access_token' ? 'secret-value' : Reflect.get(t, k); },
    });
    const r = validateEventEnvelope(envelope({ payload: proxied }));
    expect(r.ok).toBe(false);
    expect(reads).toBe(0);
  });

  it('control: the same content as plain data is accepted, and the returned envelope is the scanned snapshot, not the input', () => {
    const payload = plainPayload();
    const input = envelope({ payload });
    const r = validateEventEnvelope(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.payload).toEqual(payload);
      expect(r.envelope.payload).not.toBe(payload);
      // mutating the input after validation cannot change what was returned
      (payload as Record<string, unknown>).access_token = 'late';
      expect(r.envelope.payload).not.toHaveProperty('access_token');
    }
    const pub = checkEventPublication(publication('EngagementDetected', 'engagement_intelligence', plainPayload()));
    expect(pub.ok).toBe(true);
  });

  it('a shared, non-cyclic reference is accepted; a true cycle is still rejected', () => {
    const shared = { label: 'same' };
    const sharedPayload = { thread_id: 't', x: shared, y: shared, list: [shared, shared] };
    expect(scanPayloadForCredentials(sharedPayload)).toEqual([]);
    expect(validateEventEnvelope(envelope({ payload: sharedPayload })).ok).toBe(true);
    const cyc: Record<string, unknown> = { thread_id: 't' };
    cyc.child = { back: cyc };
    expect(scanPayloadForCredentials(cyc).map((f) => f.kind)).toContain('circular');
    expect(validateEventEnvelope(envelope({ payload: cyc })).ok).toBe(false);
    const selfArr: unknown[] = [];
    selfArr.push(selfArr);
    expect(validateEventEnvelope(envelope({ payload: { list: selfArr } })).ok).toBe(false);
    // a credential inside a shared reference is still found on every path
    const badShared = { access_token: 'v' };
    expect(validateEventEnvelope(envelope({ payload: { x: badShared, y: badShared } })).ok).toBe(false);
  });

  const PINNED = ['token_count', 'auth_status', 'cookie_consent', 'signature'];
  it.each(PINNED)('pinned stricter-than-redaction key %s is rejected by design and named in ADR-0002', (k) => {
    expect(isForbiddenPayloadKey(k)).toBe(true);
    expect(validateEventEnvelope(envelope({ payload: { thread_id: 't', [k]: 'v' } })).ok).toBe(false);
    const adr = require('fs').readFileSync(join(REPO_ROOT, 'docs/adr/ADR-0002-event-envelope-and-delivery-semantics.md'), 'utf8') as string;
    expect(adr).toContain('`' + k + '`');
  });
  it('control for the pinned keys: neighbouring ordinary keys pass', () => {
    for (const k of ['status', 'consent_recorded', 'signal_id', 'author_status']) {
      expect({ k, f: isForbiddenPayloadKey(k) }).toEqual({ k, f: false });
      expect(validateEventEnvelope(envelope({ payload: { thread_id: 't', [k]: 'v' } })).ok).toBe(true);
    }
  });
});

describe('final review of 34b4a6ae5: reserved own keys', () => {
  it('rejects a JSON-parsed envelope whose payload exists only under "__proto__"', () => {
    const base = envelope();
    const { payload, ...rest } = base;
    const json = JSON.stringify(rest).replace(/}$/, ',"__proto__":' + JSON.stringify({ payload }) + '}');
    const parsed = JSON.parse(json);
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'payload')).toBe(false);
    expect(validateEventEnvelope(parsed).ok).toBe(false);
    expect(checkEventPublication(parsed).ok).toBe(false);
  });

  it('rejects a payload-level "__proto__" key (JSON-parsed) and nested occurrences', () => {
    const json = JSON.stringify(envelope({ payload: { thread_id: 't', message_id: null, platform: 'x' } }))
      .replace('"thread_id":"t"', '"thread_id":"t","__proto__":{"access_token":"v"}');
    const parsed = JSON.parse(json);
    expect(Object.prototype.hasOwnProperty.call(parsed.payload, '__proto__')).toBe(true);
    expect(validateEventEnvelope(parsed).ok).toBe(false);
    expect(scanPayloadForCredentials(parsed.payload).map((f) => f.kind)).toContain('reserved_key');
    const nested = JSON.parse('{"meta":{"list":[{"__proto__":{"x":1}}]}}');
    expect(validateEventEnvelope(envelope({ payload: nested })).ok).toBe(false);
  });

  it.each(['constructor', 'prototype'])('rejects an own "%s" key (consistency choice)', (k) => {
    expect(validateEventEnvelope(envelope({ payload: { thread_id: 't', [k]: 'v' } })).ok).toBe(false);
    expect(validateEventEnvelope(JSON.parse(JSON.stringify(envelope()).replace(/}$/, ',"' + k + '":1}'))).ok).toBe(false);
  });

  it('control: the same envelope JSON-parsed without reserved keys is accepted; returned objects have Object.prototype', () => {
    const parsed = JSON.parse(JSON.stringify(envelope({ payload: { thread_id: 't', meta: { list: [{ a: 1 }] } } })));
    const r = validateEventEnvelope(parsed);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.getPrototypeOf(r.envelope)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(r.envelope.payload)).toBe(Object.prototype);
      const meta = r.envelope.payload.meta as { list: Record<string, unknown>[] };
      expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
      expect(Array.isArray(meta.list)).toBe(true);
      expect(Object.getPrototypeOf(meta.list[0])).toBe(Object.prototype);
      expect(r.envelope.payload).toEqual({ thread_id: 't', meta: { list: [{ a: 1 }] } });
    }
    const pub = checkEventPublication(JSON.parse(JSON.stringify(publication('EngagementDetected', 'engagement_intelligence', { thread_id: 't', message_id: null, platform: 'x' }))));
    expect(pub.ok).toBe(true);
    if (pub.ok) expect(Object.getPrototypeOf(pub.envelope.payload)).toBe(Object.prototype);
  });

  it('control: keys that merely contain the reserved words are allowed', () => {
    for (const k of ['proto', 'constructor_id', 'prototype_version', '__protocol']) {
      expect({ k, ok: validateEventEnvelope(envelope({ payload: { thread_id: 't', [k]: 'v' } })).ok }).toEqual({ k, ok: true });
    }
  });
});

describe('event catalogue integrity', () => {
  it('has no integrity violations', () => {
    expect(catalogueIntegrityViolations()).toEqual([]);
  });

  it('the integrity check is live: it catches a duplicate, an unknown controller and each rule widening', () => {
    const base = [...EVENT_CATALOGUE];
    const approved = entry('LeadApproved');
    const voiceReq = entry('VoiceSessionRequested');
    const done = entry('ExecutionCompleted');
    expect(catalogueIntegrityViolations([...base, base[0]]).join('\n')).toMatch(/duplicate/);
    expect(catalogueIntegrityViolations([{ ...base[0], programme_name: 'X', event_type: 'X', producers: ['billing' as ControllerId] }]).join('\n')).toMatch(/unknown controller/);
    expect(catalogueIntegrityViolations([{ ...approved, producers: ['lead_intelligence', 'engagement_intelligence'] }]).join('\n')).toMatch(/only by lead_intelligence/);
    expect(catalogueIntegrityViolations([{ ...approved, requires_human_approver: undefined }]).join('\n')).toMatch(/human approver/);
    expect(catalogueIntegrityViolations([{ ...voiceReq, producers: ['outreach_orchestration', 'lead_intelligence'] }]).join('\n')).toMatch(/voice_sdr/);
    expect(catalogueIntegrityViolations([{ ...done, producers: ['outreach_orchestration'] }]).join('\n')).toMatch(/outcome-bearing/);
    // control: the unmodified rows are clean
    expect(catalogueIntegrityViolations([approved, voiceReq, done])).toEqual([]);
  });

  it('contains exactly the programme events', () => {
    expect(EVENT_CATALOGUE.map((e) => e.programme_name).sort()).toEqual([...PROGRAMME_EVENTS].sort());
  });

  it('reuses the existing wire name only where the meaning is the same, and never collides otherwise', () => {
    const listening = new Set<string>(LISTENING_EVENT_TYPES);
    for (const e of EVENT_CATALOGUE) {
      if (e.existing_equivalent) {
        expect(listening.has(e.event_type)).toBe(true);
      } else {
        expect({ e: e.programme_name, collides: listening.has(e.event_type) }).toEqual({ e: e.programme_name, collides: false });
      }
    }
    expect(entry('ProspectSignalDetected').event_type).toBe('lead_signal.created');
  });

  it('every referenced existing module and not-equivalent source file exists on disk', () => {
    for (const e of EVENT_CATALOGUE) {
      for (const p of [...(e.existing_equivalent ? [e.existing_equivalent.defined_in, ...e.existing_equivalent.published_by] : []), ...(e.not_equivalent_to ?? []).map((n) => n.defined_in)]) {
        expect({ p, exists: existsSync(join(REPO_ROOT, p)) }).toEqual({ p, exists: true });
      }
    }
  });

  it('accepts a minimal valid publication for every catalogue event (no row is unreachable)', () => {
    const samples: Record<string, Record<string, unknown>> = {
      ProspectSignalDetected: { lead_signal_id: 's', platform: 'linkedin', source_type: 'engagement' },
      MarketSignalDetected: { market_signal_id: 'm', signal_category: 'pricing' },
      ProspectEnrichmentRequested: { prospect_id: 'p', requested_attributes: ['email_status'] },
      ProspectEnrichmentCompleted: { prospect_id: 'p', enrichment_status: 'unknown' },
      ProspectQualificationRequested: { prospect_id: 'p', policy_version: null },
      ProspectQualificationCompleted: { prospect_id: 'p', qualification_status: 'qualified', engine_version: 'v1' },
      LeadReviewRequested: { lead_id: 'l', reason_code: 'low_confidence' },
      LeadApproved: approvedPayload(),
      LeadRejected: { ...approvedPayload(), reason_code: 'not_icp' },
      LeadAddedToList: { lead_id: 'l', list_id: 'list' },
      EngagementDetected: { thread_id: 't', message_id: 'm', platform: 'x' },
      EngagementClassified: { thread_id: 't', classification: 'buying_intent', classifier_version: 'v1' },
      ResponseRecommendationCreated: { thread_id: 't', recommendation_id: 'r', requires_human_approval: true },
      CampaignExecutionRequested: { campaign_id: 'c', execution_request_id: 'e' },
      ChannelExecutionRequested: { execution_request_id: 'e', channel: 'email', action: 'send', idempotency_key: 'k' },
      ExecutionCompleted: { execution_request_id: 'e', channel: 'email', outcome: 'accepted', provider_reference: null },
      ExecutionFailed: { execution_request_id: 'e', channel: 'email', outcome: 'failed', failure_code: 'provider_rejected' },
      InboundResponseReceived: { inbound_message_id: 'i', channel: 'email', related_execution_request_id: null, thread_id: null },
      NextBestActionRecommended: { lead_id: 'l', action_code: 'send_follow_up', recommender_version: 'v1' },
      VoiceSessionRequested: { voice_session_id: 'v', lead_id: 'l', objective_code: 'book_meeting', objective_version: 'v1' },
      VoiceSessionStarted: { voice_session_id: 'v' },
      VoiceSessionCompleted: { voice_session_id: 'v', call_outcome: 'attempted', disposition_code: null },
      ExecutionOutcomeUnknown: { execution_request_id: 'e', channel: 'email', outcome: 'unknown', unknown_reason_code: 'response_lost' },
      VoiceSessionFailed: { voice_session_id: 'v', call_outcome: 'not_attempted', failure_code: 'no_transport' },
      VoiceSessionOutcomeUnknown: { voice_session_id: 'v', call_outcome: 'unknown', unknown_reason_code: 'status_callback_lost' },
    };
    for (const e of EVENT_CATALOGUE) {
      for (const producer of e.producers) {
        const r = checkEventPublication(publication(e.programme_name, producer, samples[e.programme_name]));
        expect({ e: e.programme_name, producer, errors: r.ok ? [] : r.errors }).toEqual({ e: e.programme_name, producer, errors: [] });
      }
      // a non-producer is refused for every event (pairs with the acceptance above)
      const outsider = CONTROLLER_IDS.find((c) => !e.producers.includes(c));
      if (outsider) {
        expect(checkEventPublication(publication(e.programme_name, outsider, samples[e.programme_name])).ok).toBe(false);
      }
    }
  });

  it('rejects an event that is not in the catalogue, or at an unknown version', () => {
    const ok = publication('EngagementDetected', 'engagement_intelligence', { thread_id: 't', message_id: null, platform: 'x' });
    expect(checkEventPublication(ok).ok).toBe(true);
    expect(checkEventPublication({ ...ok, event_type: 'EngagementDetectedV2' }).ok).toBe(false);
    expect(checkEventPublication({ ...ok, event_version: 2 }).ok).toBe(false);
  });

  it('rejects a payload with an extra (unlisted) key and a wrong entity_type', () => {
    const ok = publication('EngagementDetected', 'engagement_intelligence', { thread_id: 't', message_id: null, platform: 'x' });
    expect(checkEventPublication(ok).ok).toBe(true);
    expect(checkEventPublication({ ...ok, payload: { ...(ok.payload as object), author_email: 'a@b.c' } }).ok).toBe(false);
    expect(checkEventPublication({ ...ok, entity_type: 'lead' }).ok).toBe(false);
  });

  it('rejects a target controller that does not consume the event', () => {
    const base = publication('LeadAddedToList', 'lead_intelligence', { lead_id: 'l', list_id: 'x' });
    expect(checkEventPublication({ ...base, target_controller: 'outreach_orchestration' }).ok).toBe(true);
    expect(checkEventPublication({ ...base, target_controller: 'channel_execution' }).ok).toBe(false);
  });
});

describe('business rules', () => {
  it('R1: only Lead Intelligence may publish LeadApproved / LeadRejected', () => {
    for (const name of ['LeadApproved', 'LeadRejected']) {
      const payload = name === 'LeadApproved' ? approvedPayload() : { ...approvedPayload(), reason_code: 'not_icp' };
      expect(checkEventPublication(publication(name, 'lead_intelligence', payload)).ok).toBe(true);
      for (const other of CONTROLLER_IDS.filter((c) => c !== 'lead_intelligence')) {
        expect({ name, other, ok: checkEventPublication(publication(name, other, payload)).ok }).toEqual({ name, other, ok: false });
      }
    }
  });

  it('R1: LeadApproved / LeadRejected require a human approver id', () => {
    const ok = publication('LeadApproved', 'lead_intelligence', approvedPayload());
    expect(checkEventPublication(ok).ok).toBe(true);
    const without = { ...approvedPayload() } as Record<string, unknown>;
    delete without.approver_user_id;
    expect(checkEventPublication({ ...ok, payload: without }).ok).toBe(false);
    expect(checkEventPublication({ ...ok, payload: { ...approvedPayload(), approver_user_id: '' } }).ok).toBe(false);
    expect(checkEventPublication({ ...ok, payload: { ...approvedPayload(), approver_kind: 'model' } }).ok).toBe(false);
    expect(checkEventPublication({ ...ok, payload: { ...approvedPayload(), approver_kind: 'system' } }).ok).toBe(false);
    const rejectedOk = publication('LeadRejected', 'lead_intelligence', { ...approvedPayload(), reason_code: 'not_icp' });
    expect(checkEventPublication(rejectedOk).ok).toBe(true);
    expect(checkEventPublication({ ...rejectedOk, payload: { ...approvedPayload(), reason_code: 'not_icp', approver_kind: 'rule' } }).ok).toBe(false);
  });

  it('R2: Engagement Intelligence may publish ProspectSignalDetected but never LeadApproved', () => {
    const signal = publication('ProspectSignalDetected', 'engagement_intelligence', { lead_signal_id: 's', platform: 'linkedin', source_type: 'engagement' });
    expect(checkEventPublication(signal).ok).toBe(true);
    const approval = publication('LeadApproved', 'engagement_intelligence', approvedPayload());
    expect(checkEventPublication(approval).ok).toBe(false);
    expect(eventsPublishedBy('engagement_intelligence')).toContain('ProspectSignalDetected');
    expect(eventsPublishedBy('engagement_intelligence')).not.toContain('LeadApproved');
    expect(eventsPublishedBy('engagement_intelligence')).not.toContain('LeadRejected');
  });

  it('R3: Voice SDR receives objectives only from Outreach Orchestration', () => {
    const payload = { voice_session_id: 'v', lead_id: 'l', objective_code: 'book_meeting', objective_version: 'v1' };
    const ok = publication('VoiceSessionRequested', 'outreach_orchestration', payload, { target_controller: 'voice_sdr' });
    expect(checkEventPublication(ok).ok).toBe(true);
    for (const other of CONTROLLER_IDS.filter((c) => c !== 'outreach_orchestration')) {
      expect({ other, ok: checkEventPublication({ ...ok, source_controller: other }).ok }).toEqual({ other, ok: false });
    }
    // any event, from anyone but orchestration, addressed to voice_sdr is refused
    const toVoice = publication('LeadAddedToList', 'lead_intelligence', { lead_id: 'l', list_id: 'x' }, { target_controller: 'voice_sdr' });
    expect(checkEventPublication(toVoice).ok).toBe(false);
    for (const name of eventsConsumedBy('voice_sdr')) {
      expect(entry(name).producers).toEqual(['outreach_orchestration']);
    }
    expect(eventsConsumedBy('voice_sdr')).toEqual(['VoiceSessionRequested']);
  });

  describe('R4: channel execution outcomes', () => {
    const completed = (outcome: unknown) =>
      publication('ExecutionCompleted', 'channel_execution', { execution_request_id: 'e', channel: 'email', outcome, provider_reference: null });
    const failed = (outcome: unknown) =>
      publication('ExecutionFailed', 'channel_execution', { execution_request_id: 'e', channel: 'email', outcome, failure_code: 'x' });
    const unknownEv = (outcome: unknown) =>
      publication('ExecutionOutcomeUnknown', 'channel_execution', { execution_request_id: 'e', channel: 'email', outcome, unknown_reason_code: 'response_lost' });

    it('the vocabulary is exactly the six values, partitioned across three events without overlap', () => {
      expect([...EXECUTION_OUTCOMES].sort()).toEqual(['accepted', 'attempted', 'delivered', 'failed', 'not_attempted', 'unknown']);
      expect([...COMPLETED_OUTCOMES, ...FAILED_OUTCOMES, ...UNKNOWN_OUTCOMES].sort()).toEqual([...EXECUTION_OUTCOMES].sort());
      expect([...COMPLETED_OUTCOMES].sort()).toEqual(['accepted', 'attempted', 'delivered']);
      expect([...FAILED_OUTCOMES].sort()).toEqual(['failed', 'not_attempted']);
      expect([...UNKNOWN_OUTCOMES]).toEqual(['unknown']);
      expect(outcomeOptions(entry('ExecutionCompleted'))!.sort()).toEqual([...COMPLETED_OUTCOMES].sort());
      expect(outcomeOptions(entry('ExecutionFailed'))!.sort()).toEqual([...FAILED_OUTCOMES].sort());
      expect(outcomeOptions(entry(UNKNOWN_OUTCOME_EVENT))).toEqual(['unknown']);
    });

    it.each(COMPLETED_OUTCOMES)('ExecutionCompleted accepts %s', (o) => {
      expect(checkEventPublication(completed(o)).ok).toBe(true);
    });
    it.each(FAILED_OUTCOMES)('ExecutionFailed accepts %s', (o) => {
      expect(checkEventPublication(failed(o)).ok).toBe(true);
    });
    it('ExecutionOutcomeUnknown accepts unknown', () => {
      expect(checkEventPublication(unknownEv('unknown')).ok).toBe(true);
    });

    it.each([undefined, null, '', 'success', 'sent', 'error', 'UNKNOWN', true, 1])('rejects outcome %p in all three events (never defaulted)', (o) => {
      expect(checkEventPublication(completed(o)).ok).toBe(false);
      expect(checkEventPublication(failed(o)).ok).toBe(false);
      expect(checkEventPublication(unknownEv(o)).ok).toBe(false);
    });

    it('a missing outcome key is rejected, not defaulted (control: present key accepted)', () => {
      for (const ev of [completed('accepted'), failed('failed'), unknownEv('unknown')]) {
        expect(checkEventPublication(ev).ok).toBe(true);
        const { outcome: _drop, ...rest } = ev.payload as Record<string, unknown>;
        expect(checkEventPublication({ ...ev, payload: rest }).ok).toBe(false);
      }
    });

    it('unknown travels ONLY in ExecutionOutcomeUnknown and is preserved verbatim', () => {
      const r = checkEventPublication(unknownEv('unknown'));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.envelope.payload.outcome).toBe('unknown');
      expect(checkEventPublication(completed('unknown')).ok).toBe(false);
      expect(checkEventPublication(failed('unknown')).ok).toBe(false);
      // and the unknown event cannot smuggle a known outcome
      for (const o of [...COMPLETED_OUTCOMES, ...FAILED_OUTCOMES]) {
        expect({ o, ok: checkEventPublication(unknownEv(o)).ok }).toEqual({ o, ok: false });
      }
    });

    it('the integrity check refuses a row that lets unknown back into Completed (control: real row clean)', () => {
      const real = entry('ExecutionCompleted');
      expect(catalogueIntegrityViolations([real])).toEqual([]);
      const widened: CatalogueEntry = {
        ...real,
        payload: z.strictObject({ execution_request_id: z.string(), channel: z.string(), outcome: z.enum(EXECUTION_OUTCOMES), provider_reference: z.string().nullable() }),
      };
      expect(catalogueIntegrityViolations([widened]).join('\n')).toMatch(/may travel only in ExecutionOutcomeUnknown/);
      const unknownRow = entry(UNKNOWN_OUTCOME_EVENT);
      expect(catalogueIntegrityViolations([unknownRow])).toEqual([]);
      const narrowed: CatalogueEntry = { ...unknownRow, payload: z.strictObject({ outcome: z.enum(['failed']) }) };
      expect(catalogueIntegrityViolations([narrowed]).join('\n')).toMatch(/may travel only in ExecutionOutcomeUnknown/);
    });

    it('an outcome payload cannot carry a success/failure flag beside the outcome', () => {
      for (const ev of [unknownEv('unknown'), completed('delivered')]) {
        expect(checkEventPublication(ev).ok).toBe(true);
        expect(checkEventPublication({ ...ev, payload: { ...(ev.payload as object), success: true } }).ok).toBe(false);
        expect(checkEventPublication({ ...ev, payload: { ...(ev.payload as object), succeeded: false } }).ok).toBe(false);
      }
    });

    it('only Channel Execution may publish outcome events', () => {
      for (const ev of [completed('delivered'), failed('failed'), unknownEv('unknown')]) {
        expect(checkEventPublication(ev).ok).toBe(true);
        expect(checkEventPublication({ ...ev, source_controller: 'outreach_orchestration' }).ok).toBe(false);
      }
      for (const e of EVENT_CATALOGUE.filter((x) => x.outcome_bearing)) expect(e.producers).toEqual(['channel_execution']);
      expect(EVENT_CATALOGUE.filter((x) => x.outcome_bearing).map((x) => x.programme_name).sort()).toEqual(
        ['ExecutionCompleted', 'ExecutionFailed', 'ExecutionOutcomeUnknown'],
      );
    });
  });

  describe('R4 (voice mirror): call outcomes', () => {
    const vCompleted = (o: unknown) =>
      publication('VoiceSessionCompleted', 'voice_sdr', { voice_session_id: 'v', call_outcome: o, disposition_code: null });
    const vFailed = (o: unknown) =>
      publication('VoiceSessionFailed', 'voice_sdr', { voice_session_id: 'v', call_outcome: o, failure_code: 'x' });
    const vUnknown = (o: unknown) =>
      publication('VoiceSessionOutcomeUnknown', 'voice_sdr', { voice_session_id: 'v', call_outcome: o, unknown_reason_code: 'status_callback_lost' });

    it('partitions call_outcome exactly like channel execution', () => {
      expect(outcomeOptions(entry('VoiceSessionCompleted'), 'call_outcome')!.sort()).toEqual([...COMPLETED_OUTCOMES].sort());
      expect(outcomeOptions(entry('VoiceSessionFailed'), 'call_outcome')!.sort()).toEqual([...FAILED_OUTCOMES].sort());
      expect(outcomeOptions(entry(VOICE_UNKNOWN_OUTCOME_EVENT), 'call_outcome')).toEqual(['unknown']);
    });

    it('unknown travels ONLY in VoiceSessionOutcomeUnknown and is preserved verbatim', () => {
      const r = checkEventPublication(vUnknown('unknown'));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.envelope.payload.call_outcome).toBe('unknown');
      expect(checkEventPublication(vCompleted('unknown')).ok).toBe(false);
      expect(checkEventPublication(vFailed('unknown')).ok).toBe(false);
      // controls: the known values are accepted where they belong
      for (const o of COMPLETED_OUTCOMES) expect(checkEventPublication(vCompleted(o)).ok).toBe(true);
      for (const o of FAILED_OUTCOMES) expect(checkEventPublication(vFailed(o)).ok).toBe(true);
      // and the unknown event cannot smuggle a known outcome
      for (const o of [...COMPLETED_OUTCOMES, ...FAILED_OUTCOMES]) {
        expect({ o, ok: checkEventPublication(vUnknown(o)).ok }).toEqual({ o, ok: false });
      }
    });

    it.each([undefined, null, '', 'connected', 'UNKNOWN', true])('rejects call_outcome %p in all three voice events', (o) => {
      expect(checkEventPublication(vCompleted(o)).ok).toBe(false);
      expect(checkEventPublication(vFailed(o)).ok).toBe(false);
      expect(checkEventPublication(vUnknown(o)).ok).toBe(false);
    });

    it('requires unknown_reason_code and only Voice SDR may publish it, only to orchestration', () => {
      const ok = vUnknown('unknown');
      expect(checkEventPublication(ok).ok).toBe(true);
      const { unknown_reason_code: _d, ...rest } = ok.payload as Record<string, unknown>;
      expect(checkEventPublication({ ...ok, payload: rest }).ok).toBe(false);
      for (const other of CONTROLLER_IDS.filter((c) => c !== 'voice_sdr')) {
        expect({ other, ok: checkEventPublication({ ...ok, source_controller: other }).ok }).toEqual({ other, ok: false });
      }
      expect(entry(VOICE_UNKNOWN_OUTCOME_EVENT).consumers).toEqual(['outreach_orchestration']);
      expect(checkEventPublication({ ...ok, target_controller: 'outreach_orchestration' }).ok).toBe(true);
      expect(checkEventPublication({ ...ok, target_controller: 'lead_intelligence' }).ok).toBe(false);
    });

    it('the integrity check refuses any voice outcome row other than OutcomeUnknown that admits unknown (control: real rows clean)', () => {
      const completedRow = entry('VoiceSessionCompleted');
      const failedRow = entry('VoiceSessionFailed');
      const unknownRow = entry(VOICE_UNKNOWN_OUTCOME_EVENT);
      expect(catalogueIntegrityViolations([completedRow, failedRow, unknownRow])).toEqual([]);
      const widened: CatalogueEntry = { ...completedRow, payload: z.strictObject({ voice_session_id: z.string(), call_outcome: z.enum(EXECUTION_OUTCOMES), disposition_code: z.string().nullable() }) };
      expect(catalogueIntegrityViolations([widened]).join('\n')).toMatch(/may travel only in VoiceSessionOutcomeUnknown/);
      const widenedFailed: CatalogueEntry = { ...failedRow, payload: z.strictObject({ call_outcome: z.enum(['failed', 'unknown']) }) };
      expect(catalogueIntegrityViolations([widenedFailed]).join('\n')).toMatch(/may travel only in VoiceSessionOutcomeUnknown/);
      const narrowed: CatalogueEntry = { ...unknownRow, payload: z.strictObject({ call_outcome: z.enum(['failed']) }) };
      expect(catalogueIntegrityViolations([narrowed]).join('\n')).toMatch(/may travel only in VoiceSessionOutcomeUnknown/);
      const untagged: CatalogueEntry = { ...completedRow, call_outcome_bearing: undefined };
      expect(catalogueIntegrityViolations([untagged]).join('\n')).toMatch(/must be call_outcome_bearing/);
      const wrongProducer: CatalogueEntry = { ...unknownRow, producers: ['channel_execution'] };
      expect(catalogueIntegrityViolations([wrongProducer]).join('\n')).toMatch(/produced only by voice_sdr/);
    });
  });

  it('R1 limit is documented: the approver is structural only, runtime verification is the producer\'s duty', () => {
    for (const name of ['LeadApproved', 'LeadRejected']) {
      expect(entry(name).description).toMatch(/verify it against the tenant's users at runtime/);
    }
  });
});

describe('controller register', () => {
  it('has exactly one row per controller', () => {
    expect(CONTROLLER_REGISTER.map((c) => c.id).sort()).toEqual([...CONTROLLER_IDS].sort());
  });

  it.each(CONTROLLER_IDS)('%s publishes/consumes exactly what the catalogue says', (id) => {
    const row = CONTROLLER_REGISTER.find((c) => c.id === id)!;
    expect([...row.publishes].sort()).toEqual(eventsPublishedBy(id).sort());
    expect([...row.consumes].sort()).toEqual(eventsConsumedBy(id).sort());
  });

  it('every existing module path exists on disk', () => {
    for (const c of CONTROLLER_REGISTER) {
      for (const p of c.existing_modules) {
        expect({ c: c.id, p, exists: existsSync(join(REPO_ROOT, p)) }).toEqual({ c: c.id, p, exists: true });
      }
    }
    // control: the path check can fail
    expect(existsSync(join(REPO_ROOT, 'backend/services/voiceSdrService.ts'))).toBe(false);
  });

  it('Voice SDR is contract-only with no existing module; every other controller maps real modules', () => {
    for (const c of CONTROLLER_REGISTER) {
      if (c.id === 'voice_sdr') {
        expect(c.status).toBe('contract_only');
        expect(c.existing_modules).toEqual([]);
      } else {
        expect(c.status).toBe('existing_modules_mapped');
        expect(c.existing_modules.length).toBeGreaterThan(0);
      }
    }
  });

  it('shared-service dependencies reference registered shared services; owners are from the approved list', () => {
    const ids = new Set<string>(SHARED_SERVICE_IDS);
    for (const c of CONTROLLER_REGISTER) {
      for (const d of c.shared_service_dependencies) expect({ c: c.id, d, known: ids.has(d) }).toEqual({ c: c.id, d, known: true });
      expect(SHARED_SERVICE_OWNERS).toContain(c.owner);
    }
  });
});

describe('shared-service register', () => {
  it('has exactly one row per shared service, every path exists', () => {
    expect(SHARED_SERVICE_REGISTER.map((s) => s.id).sort()).toEqual([...SHARED_SERVICE_IDS].sort());
    for (const s of SHARED_SERVICE_REGISTER) {
      expect(s.existing_modules.length).toBeGreaterThan(0);
      for (const p of s.existing_modules) expect({ s: s.id, p, exists: existsSync(join(REPO_ROOT, p)) }).toEqual({ s: s.id, p, exists: true });
    }
  });

  it('owners are exactly as approved', () => {
    const owners = Object.fromEntries(SHARED_SERVICE_REGISTER.map((s) => [s.id, s.owner]));
    expect(owners).toEqual({
      event_contracts: 'control-tower (interim)',
      tenant_context_contracts: 'control-tower (interim)',
      migration_coordination: 'control-tower (interim)',
      token_storage: 'a9 (proposed, unconfirmed)',
      account_binding: 'a9 (proposed, unconfirmed)',
      tenant_company_resolution: 'a9 (proposed, unconfirmed)',
      capability_registry: 'a9 (proposed, unconfirmed)',
      execution_policy: 'a9 (proposed, unconfirmed)',
      transport_pairing: 'UNASSIGNED',
      job_lifecycle_retry: 'UNASSIGNED',
      events_infrastructure: 'UNASSIGNED',
      observability: 'UNASSIGNED',
    });
  });

  it('the contracts area imports nothing with runtime side effects (no db, queue, network)', () => {
    const fs = require('fs') as typeof import('fs');
    const dir = join(REPO_ROOT, 'backend/contracts/controllers');
    const forbidden = /from ['"][^'"]*(supabase|db\/|queue|bullmq|ioredis|redis|writeOwner|fetch|axios|services\/)/;
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const src = fs.readFileSync(join(dir, f), 'utf8');
      expect({ f, hit: src.match(forbidden)?.[0] ?? null }).toEqual({ f, hit: null });
    }
    // control: the pattern catches a real runtime import
    expect("import { supabase } from '../../db/supabaseClient';").toMatch(forbidden);
  });
});
