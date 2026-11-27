/**
 * Round 26 / C3 — FAIL-CLOSED E2E Redis guard (owner decision).
 *
 * The guard must POSITIVELY IDENTIFY the approved disposable Redis and refuse production REGARDLESS
 * OF HOSTNAME. These tests drive the real resolver (hosted mode) and the shared rule
 * (scripts/lib/e2eRedisIdentityRule.cjs) through the guard's exports.
 *
 * Failing controls:
 *   - every refusal test FAILS against the f237b92f0 guard (run in a detached control worktree; see
 *     CT-ROUND26-C3-REDIS-GUARD.md), because that guard accepts any non-listed hosted Redis and has
 *     no marker check;
 *   - each rule additionally has an in-spec mutation control below: with that rule removed from a
 *     copy of the shared module, the same input is ACCEPTED, so the rule is load-bearing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import * as guard from './e2eEnvironmentGuard';

type Env = Record<string, string | undefined>;

const E2E_URL = `https://${guard.DEFAULT_EXPECTED_E2E_PROJECT_REF}.supabase.co`;
const VALID_KEY = 'sb-service-role-key-for-tests-only-not-a-real-credential';
const LIVE = 'right-treefrog-90757.upstash.io';
const STALE = 'noble-dane-77325.upstash.io';
const APPROVED = 'c3-disposable-e2e-0001.upstash.io';
const UNAPPROVED = 'brave-otter-12345.upstash.io'; // the B1 review probe: accepted before C3
const PW = 'fixture-redis-pw';
const TOKEN = 'c3-run-token-0123456789abcdef';
const APPROVED_URL = `rediss://default:${PW}@${APPROVED}:6379`;

/** Hosted-mode environment with NO Redis unless the overrides add one. */
function hostedEnv(overrides: Env = {}): Env {
  const env: Env = {
    E2E_SUPABASE_URL: E2E_URL,
    SUPABASE_URL: E2E_URL,
    NEXT_PUBLIC_SUPABASE_URL: E2E_URL,
    E2E_SUPABASE_SECRET_KEY: VALID_KEY,
    AUTH_E2E_BASE_URL: 'http://localhost:3000',
    ...overrides,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** The fully approved hosted shape. */
function approvedEnv(overrides: Env = {}): Env {
  return hostedEnv({ E2E_REDIS_URL: APPROVED_URL, E2E_REDIS_APPROVED_HOST: APPROVED, E2E_REDIS_IDENTITY_TOKEN: TOKEN, ...overrides });
}

const SECRETS = [PW, TOKEN, VALID_KEY, LIVE, STALE, APPROVED, UNAPPROVED, 'right-treefrog', 'noble-dane'];

function refused(env: Env, why: string, rule: RegExp): void {
  assert.throws(
    () => guard.resolveAuthE2ETarget(env),
    (e: unknown) => {
      assert.ok(e instanceof guard.E2EEnvironmentError, `${why}: wrong error type ${String(e)}`);
      const m = (e as Error).message;
      for (const s of SECRETS) assert.ok(!m.toLowerCase().includes(s.toLowerCase()), `${why}: the message echoed a value`);
      assert.match(m, rule, `${why}: must name the rule`);
      return true;
    },
    why,
  );
}

const PROD = /PRODUCTION Redis|R-PROD-IDENTITY|R-APPROVED-IS-PROD/;

// ------------------------------------------------------------------ positive identification
test('C3 unapproved hosted Redis is REFUSED (positive identification)', () => {
  refused(approvedEnv({ E2E_REDIS_URL: `rediss://default:${PW}@${UNAPPROVED}:6379` }), 'unapproved Upstash host', /R-NOT-APPROVED/);
  refused(approvedEnv({ E2E_REDIS_URL: `redis://cache.internal.example.net:6379` }), 'unapproved non-Upstash host', /R-NOT-APPROVED/);
  refused(approvedEnv({ E2E_REDIS_URL: `rediss://default:${PW}@${APPROVED}.:6379` }), 'approved host with a trailing dot (not exact)', /R-NOT-APPROVED/);
  refused(approvedEnv({ E2E_REDIS_URL: `rediss://default:${PW}@sub.${APPROVED}:6379` }), 'a subdomain of the approved host', /R-NOT-APPROVED/);
});

test('C3 approved hosted Redis is ALLOWED (paired with the refusals above: only the host differs)', () => {
  const target = guard.resolveAuthE2ETarget(approvedEnv());
  assert.equal(target.mode, 'hosted');
  const r = guard.resolveHostedRedisTarget('hosted', approvedEnv());
  assert.ok(r && r.kind === 'hosted' && r.variable === 'E2E_REDIS_URL' && r.markerToken === TOKEN);
  // Upper-case spelling of the approved host is the same host (WHATWG lower-cases it).
  assert.equal(guard.resolveAuthE2ETarget(approvedEnv({ E2E_REDIS_URL: `rediss://default:${PW}@${APPROVED.toUpperCase()}:6379` })).mode, 'hosted');
  // A matching fingerprint (host, port, user; never the password) is accepted.
  const fp = guard.redisIdentityFingerprint(APPROVED_URL);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(guard.resolveAuthE2ETarget(approvedEnv({ E2E_REDIS_APPROVED_FINGERPRINT: fp })).mode, 'hosted');
  assert.equal(guard.redisIdentityFingerprint(`rediss://default:other-pw@${APPROVED}:6379`), fp, 'the password is not part of the fingerprint');
});

test('C3 a fingerprint mismatch is REFUSED', () => {
  const otherPort = guard.redisIdentityFingerprint(`rediss://default:${PW}@${APPROVED}:6380`);
  refused(approvedEnv({ E2E_REDIS_APPROVED_FINGERPRINT: otherPort }), 'fingerprint of another port', /R-FINGERPRINT/);
  refused(approvedEnv({ E2E_REDIS_APPROVED_FINGERPRINT: 'not-a-digest' }), 'malformed fingerprint', /R-FINGERPRINT/);
});

test('C3 missing approval configuration is REFUSED (fail closed)', () => {
  refused(approvedEnv({ E2E_REDIS_APPROVED_HOST: undefined }), 'no approved host', /R-APPROVAL-MISSING/);
  refused(approvedEnv({ E2E_REDIS_APPROVED_HOST: '   ' }), 'blank approved host', /R-APPROVAL-MISSING/);
  refused(approvedEnv({ E2E_REDIS_IDENTITY_TOKEN: undefined }), 'no identity token', /R-APPROVAL-MISSING/);
  refused(approvedEnv({ E2E_REDIS_IDENTITY_TOKEN: 'short' }), 'a too-short token', /R-APPROVAL-MISSING/);
  refused(approvedEnv({ E2E_REDIS_IDENTITY_TOKEN: 'placeholder-token-0123456789' }), 'a placeholder token', /R-APPROVAL-MISSING/);
  refused(approvedEnv({ E2E_REDIS_APPROVED_HOST: `rediss://${APPROVED}:6379` }), 'approval given as a URL, not an exact host', /R-APPROVAL-MISSING/);
  refused(approvedEnv({ E2E_REDIS_APPROVED_HOST: `${APPROVED}.` }), 'approval with a trailing dot', /R-APPROVAL-MISSING/);
});

test('C3 a hosted Redis named by the production variable REDIS_URL is REFUSED', () => {
  // Review M1: reported as R-NOT-APPROVED (only E2E_REDIS_URL may name a hosted Redis).
  refused(hostedEnv({ REDIS_URL: APPROVED_URL, E2E_REDIS_APPROVED_HOST: APPROVED, E2E_REDIS_IDENTITY_TOKEN: TOKEN }), 'hosted target via REDIS_URL', /R-NOT-APPROVED/);
  refused(hostedEnv({ REDIS_URL: 'redis://127.0.0.2:6379' }), 'a non-loopback 127.0.0.2 via REDIS_URL', /R-NOT-APPROVED/);
});

test('C3 loopback (the CI service container) is unaffected and needs no approval', () => {
  assert.equal(guard.resolveAuthE2ETarget(hostedEnv({ REDIS_URL: 'redis://127.0.0.1:6379' })).mode, 'hosted');
  assert.equal(guard.resolveAuthE2ETarget(hostedEnv({})).mode, 'hosted', 'no Redis variable at all: nothing to identify');
  assert.equal(guard.resolveHostedRedisTarget('hosted', hostedEnv({ REDIS_URL: 'redis://127.0.0.1:6379' }))?.kind, 'loopback');
});

// ------------------------------------------------------------------ production, regardless of hostname
test('C3 approved host == a production host is REFUSED (misconfiguration)', () => {
  for (const host of [LIVE, STALE]) {
    refused(approvedEnv({ E2E_REDIS_APPROVED_HOST: host }), `approved = ${host}`, PROD);
    refused(approvedEnv({ E2E_REDIS_URL: `rediss://default:${PW}@${host}:6379`, E2E_REDIS_APPROVED_HOST: host }), `approved = target = ${host}`, PROD);
  }
  // The production identity under another domain: only the shared rule's identity match catches it.
  refused(approvedEnv({ E2E_REDIS_APPROVED_HOST: 'right-treefrog-90757.cache.example.net' }), 'approved = prod identity, other domain', /R-APPROVED-IS-PROD/);
});

test('C3 the production host in every URL form is REFUSED, also when it is the approved host', () => {
  for (const host of [LIVE, STALE]) {
    const forms: ReadonlyArray<readonly [string, string]> = [
      ['rediss + user-info', `rediss://default:${PW}@${host}:6379`],
      ['redis, no user-info', `redis://${host}:6379`],
      ['other port', `rediss://default:${PW}@${host}:6380`],
      ['no port', `rediss://${host}`],
      ['upper case', `rediss://default:${PW}@${host.toUpperCase()}:6379`],
      ['trailing dot', `rediss://default:${PW}@${host}.:6379`],
      ['host smuggled in user-info', `rediss://${host}:${PW}@cache.example.net:6379`],
      ['percent-encoded', `rediss://default:${PW}@${host.replace('-', '%2D')}:6379`],
      ['soft hyphen', `rediss://default:${PW}@${host.slice(0, 5)}­${host.slice(5)}:6379`],
      ['full-width first letter', `rediss://default:${PW}@${String.fromCharCode(host.charCodeAt(0) + 0xfee0)}${host.slice(1)}:6379`],
      ['https REST form', `https://${host}`],
      ['identity under another domain', `rediss://default:${PW}@${host.split('.')[0]}.other-cache.example.net:6379`],
    ];
    for (const [why, url] of forms) {
      refused(approvedEnv({ E2E_REDIS_URL: url }), `${host} ${why} (E2E_REDIS_URL)`, PROD);
      refused(approvedEnv({ E2E_REDIS_URL: url, E2E_REDIS_APPROVED_HOST: host }), `${host} ${why}, approved as itself`, PROD);
    }
  }
});

test('C3 same host as a production-named variable (REDIS_URL / UPSTASH_REDIS_REST_URL) is REFUSED', () => {
  // The variables are present under their production names; the comparison is by normalised host only.
  refused(approvedEnv({ REDIS_URL: APPROVED_URL }), 'REDIS_URL equal to the target', /R-SAME-HOST-AS-PROD-VAR/);
  refused(approvedEnv({ UPSTASH_REDIS_REST_URL: `https://${APPROVED}` }), 'UPSTASH_REDIS_REST_URL same host (REST form)', /R-SAME-HOST-AS-PROD-VAR/);
  refused(approvedEnv({ UPSTASH_REDIS_REST_URL: `https://${APPROVED.toUpperCase()}.:443/` }), 'same host, other case + trailing dot + port', /R-SAME-HOST-AS-PROD-VAR/);
  refused(approvedEnv({ UPSTASH_REDIS_URL: `rediss://other:x@${APPROVED}:6380` }), 'UPSTASH_REDIS_URL same host, other user/port', /R-SAME-HOST-AS-PROD-VAR/);
  refused(approvedEnv({ REDIS_PRIVATE_URL: `redis://${APPROVED}:6379` }), 'REDIS_PRIVATE_URL same host', /R-SAME-HOST-AS-PROD-VAR/);
  // Review C1: a production-named variable on ANOTHER hosted host is refused too (not loopback, not approved).
  refused(approvedEnv({ UPSTASH_REDIS_REST_URL: 'https://some-other-instance.upstash.io' }), 'UPSTASH_REDIS_REST_URL on an unapproved host', /R-NOT-APPROVED/);
});

// ------------------------------------------------------------------ (d) runtime identity marker
function fakeRedis(marker: string | null | Error) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      get: async (key: string) => {
        calls.push(`get ${key}`);
        if (marker instanceof Error) throw marker;
        return marker;
      },
    },
  };
}

test('C3 marker ABSENT or MISMATCHING is REFUSED (and only a GET is issued)', async () => {
  assert.equal(typeof guard.assertRedisIdentityMarker, 'function', 'the guard must export the runtime identity check');
  for (const [why, marker] of [['absent', null], ['mismatch', 'c3-run-token-0123456789abcdeX'], ['empty', ''], ['read error', new Error('boom')]] as const) {
    const f = fakeRedis(marker);
    await assert.rejects(
      () => guard.assertRedisIdentityMarker(f.client, TOKEN),
      (e: unknown) => {
        const m = (e as Error).message;
        assert.match(m, /R-MARKER/, why);
        assert.ok(!m.includes(TOKEN), `${why}: token echoed`);
        return true;
      },
      why,
    );
    assert.deepEqual(f.calls, [`get ${guard.REDIS_IDENTITY_MARKER_KEY}`], `${why}: only the marker GET may be issued`);
  }
});

test('C3 marker MATCH is allowed', async () => {
  assert.equal(typeof guard.assertRedisIdentityMarker, 'function', 'the guard must export the runtime identity check');
  assert.equal(guard.REDIS_IDENTITY_MARKER_KEY, 'omnivyra:e2e:identity');
  const f = fakeRedis(TOKEN);
  await guard.assertRedisIdentityMarker(f.client, TOKEN);
  assert.deepEqual(f.calls, ['get omnivyra:e2e:identity']);
});

// ------------------------------------------------------------------ one shared rule
test('C3 one shared rule: the guard and the reset script use the same module and lists', () => {
  const req = createRequire(__filename);
  const rule = req('../../scripts/lib/e2eRedisIdentityRule.cjs');
  assert.equal(guard.PRODUCTION_REDIS_HOSTNAMES, rule.PRODUCTION_REDIS_HOSTS);
  assert.deepEqual([...rule.PRODUCTION_SUPABASE_REFS], [...guard.PRODUCTION_PROJECT_REFS]);
  for (const file of ['tests/auth/e2eEnvironmentGuard.ts', 'scripts/reset-auth-e2e-rate-limits.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.ok(src.includes("e2eRedisIdentityRule.cjs')"), `${file} must require the shared rule`);
    assert.ok(!/right-treefrog-90757\.upstash\.io'/.test(src), `${file} must not carry its own copy of the production host list`);
  }
});

// ------------------------------------------------------------------ in-spec mutation controls
const RULE_FILE = path.join(__dirname, '..', '..', 'scripts', 'lib', 'e2eRedisIdentityRule.cjs');
type RuleModule = { resolveRedisTarget: (env: Env, o?: { required?: boolean }) => unknown; assertRedisIdentityMarker: (c: unknown, t: string) => Promise<void> };

function mutantRule(mutations: ReadonlyArray<readonly [string, string]>): { mod: RuleModule; done: () => void } {
  let source = fs.readFileSync(RULE_FILE, 'utf8');
  for (const [marker, replacement] of mutations) {
    assert.equal(source.split(marker).length - 1, 1, `mutation marker must occur exactly once: ${marker}`);
    source = source.replace(marker, replacement);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-redis-rule-mutant-'));
  const file = path.join(dir, 'rule.cjs');
  fs.writeFileSync(file, source);
  return { mod: createRequire(__filename)(file) as RuleModule, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function ruleControl(name: string, mutations: ReadonlyArray<readonly [string, string]>, env: Env): void {
  assert.throws(() => guard.resolveAuthE2ETarget(env), guard.E2EEnvironmentError, `${name}: the real guard must refuse`);
  const { mod, done } = mutantRule(mutations);
  try {
    assert.doesNotThrow(() => mod.resolveRedisTarget(env, { required: false }), `${name}: with the rule removed the input must be accepted, otherwise no test protects it`);
  } finally {
    done();
  }
}

const M_NOT_APPROVED = ['  if (host !== approved) refuse(RULES.NOT_APPROVED, variable,', '  if (false) refuse(RULES.NOT_APPROVED, variable,'] as const;
const M_APPROVAL_MISSING_HOST = ["  if (typeof approvedRaw !== 'string' || approvedRaw.trim() === '') {", '  if (false) {'] as const;
const M_APPROVAL_MISSING_HOST_USE = ['  const approved = approvedRaw.trim();', "  const approved = (approvedRaw || 'brave-otter-12345.upstash.io').trim();"] as const;
const M_TOKEN_MISSING = ["  if (token === null) refuse(RULES.APPROVAL_MISSING, IDENTITY_TOKEN_VARIABLE, 'is not set;", "  if (false) refuse(RULES.APPROVAL_MISSING, IDENTITY_TOKEN_VARIABLE, 'is not set;"] as const;
const M_APPROVED_IS_PROD = ['  // (b) The approval itself must not name production (a misconfiguration), in any form.\n  if (namesProduction(approved)) refuse(', '  if (false) refuse('] as const;
const M_APPROVED_REF_HOST = ['    if (ref !== null && hostKey(ref) === hostKey(approved)) refuse(', '    if (false) refuse('] as const;
const M_PROD_IDENTITY = ['    if (namesProduction(value)) refuse(', '    if (false) refuse('] as const;
const M_SAME_HOST = ['    if (hostKey(ref) === hostKey(url)) {', '    if (false) {'] as const;

test('C3 CONTROL positive identification (exact host) is load-bearing', () => {
  ruleControl('not approved', [M_NOT_APPROVED], approvedEnv({ E2E_REDIS_URL: `rediss://default:${PW}@${UNAPPROVED}:6379` }));
});

test('C3 CONTROL missing approval (host, token) is load-bearing', () => {
  ruleControl('approval host missing', [M_APPROVAL_MISSING_HOST, M_APPROVAL_MISSING_HOST_USE, M_NOT_APPROVED], approvedEnv({ E2E_REDIS_APPROVED_HOST: undefined }));
  ruleControl('token missing', [M_TOKEN_MISSING], approvedEnv({ E2E_REDIS_IDENTITY_TOKEN: undefined }));
});

test('C3 CONTROL approved == production (identity under another domain) is load-bearing', () => {
  // Target = approved = the production identity under a non-listed domain, so only the shared rule's
  // identity layers see it: (a) on the target and (b) on the approval are both removed.
  const host = 'right-treefrog-90757.cache.example.net';
  ruleControl('approved is prod', [M_APPROVED_IS_PROD, M_PROD_IDENTITY], approvedEnv({ E2E_REDIS_URL: `rediss://default:${PW}@${host}:6379`, E2E_REDIS_APPROVED_HOST: host }));
});

test('C3 CONTROL same host as a production-named variable is load-bearing', () => {
  // The C1 endpoint rule is a further layer for the same input; it is exercised by resolveRedisTarget-only mutants here.
  ruleControl('same host as UPSTASH_REDIS_REST_URL', [M_SAME_HOST, M_APPROVED_REF_HOST], approvedEnv({ UPSTASH_REDIS_REST_URL: `https://${APPROVED}` }));
});

test('C3 CONTROL marker comparison and absence check are load-bearing', async () => {
  const { mod, done } = mutantRule([
    ["  if (typeof value !== 'string' && !Buffer.isBuffer(value)) refuse(", '  if (false) refuse('],
    ['  if (!digestEqual(String(value), expectedToken)) refuse(', '  if (false) refuse('],
  ]);
  try {
    for (const marker of [null, 'wrong-token-0123456789abcdefgh']) {
      await assert.rejects(() => guard.assertRedisIdentityMarker(fakeRedis(marker).client, TOKEN), /R-MARKER/);
      await mod.assertRedisIdentityMarker(fakeRedis(marker).client, TOKEN); // mutant: accepted
    }
  } finally {
    done();
  }
});

// ------------------------------------------------------------------ review C1: every Redis-bearing variable
const ENDPOINTS: ReadonlyArray<readonly [string, (host: string) => string]> = [
  ['CREATOR_RENDER_REDIS_URL', (h) => `rediss://default:${PW}@${h}:6379`],
  ['UPSTASH_REDIS_REST_URL', (h) => `https://${h}`],
  ['UPSTASH_REDIS_URL', (h) => `rediss://default:${PW}@${h}:6379`],
  ['REDIS_PRIVATE_URL', (h) => `redis://${h}:6379`],
  ['REDIS_HOST', (h) => h],
  ['ANALYTICS_REDIS_URL', (h) => `redis://${h}:6379`], // unknown Redis-named URL variable
  ['KV_URL', (h) => `rediss://default:${PW}@${h}:6379`], // Vercel KV naming
  ['SOME_CACHE_REDIS_ENDPOINT', (h) => `${h}:6379`], // unknown name, endpoint suffix, bare host:port
];

test('C3 C1 every Redis-bearing variable: an unapproved hosted host is REFUSED in hosted mode', () => {
  for (const [name, form] of ENDPOINTS) {
    refused(hostedEnv({ REDIS_URL: 'redis://127.0.0.1:6379', [name]: form(UNAPPROVED) }), `${name} unapproved, no approval configured`, /R-APPROVAL-MISSING/);
    refused(approvedEnv({ [name]: form(UNAPPROVED) }), `${name} unapproved, approval configured`, /R-NOT-APPROVED/);
  }
});

test('C3 C1 every Redis-bearing variable: production under ANOTHER domain is REFUSED (identity, not hostname)', () => {
  for (const [name, form] of ENDPOINTS) {
    for (const host of ['right-treefrog-90757.evil.example', 'noble-dane-77325.cache.example.net', LIVE]) {
      refused(hostedEnv({ REDIS_URL: 'redis://127.0.0.1:6379', [name]: form(host) }), `${name} = ${host}`, PROD);
    }
  }
});

test('C3 C1 every Redis-bearing variable: loopback is ALLOWED; the approved host only under a non-production name', () => {
  for (const [name, form] of ENDPOINTS) {
    for (const host of ['127.0.0.1', 'localhost']) {
      assert.equal(guard.resolveAuthE2ETarget(hostedEnv({ REDIS_URL: 'redis://127.0.0.1:6379', [name]: form(host) })).mode, 'hosted', `${name} = ${host}`);
    }
  }
  assert.equal(guard.resolveAuthE2ETarget(hostedEnv({ REDIS_HOST: '::1', REDIS_PORT: '6379' })).mode, 'hosted');
  assert.equal(guard.resolveAuthE2ETarget(hostedEnv({ REDIS_HOST: 'localhost:6379' })).mode, 'hosted');
  // The approved disposable host under a non-production name is accepted ...
  assert.equal(guard.resolveAuthE2ETarget(approvedEnv({ ANALYTICS_REDIS_URL: `redis://${APPROVED}:6379` })).mode, 'hosted');
  // ... but never under a production variable name.
  for (const name of ['CREATOR_RENDER_REDIS_URL', 'UPSTASH_REDIS_URL', 'REDIS_PRIVATE_URL']) {
    refused(approvedEnv({ [name]: `redis://${APPROVED}:6379` }), `${name} = approved`, /R-SAME-HOST-AS-PROD-VAR/);
  }
  refused(hostedEnv({ REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379x' }), 'REDIS_PORT not a number', /R-MALFORMED/);
  // Loopback spellings a client would NOT treat as loopback are refused (decided on the raw value).
  for (const v of ['127.0.0.2', '0.0.0.0', 'localhost.', '0x7f000001']) refused(hostedEnv({ REDIS_HOST: v }), `REDIS_HOST=${v}`, /R-APPROVAL-MISSING/);
  // Non-endpoint Redis settings are untouched.
  assert.equal(guard.resolveAuthE2ETarget(hostedEnv({ REDIS_PASSWORD: 'x', ALLOW_PROD_DB_WITH_LOCAL_REDIS: '1', REDIS_WAIT_MS: '10', E2E_REDIS_IDENTITY_TOKEN: TOKEN })).mode, 'hosted');
});

const M_ENDPOINT_NOT_APPROVED = ['  if (host !== approved) refuse(RULES.NOT_APPROVED, name,', '  if (false) refuse(RULES.NOT_APPROVED, name,'] as const;
const M_ENDPOINT_PROD = ["    return;\n  }\n  if (namesProduction(value)) refuse(RULES.PROD_IDENTITY, name, 'points at production; refused');", '    return;\n  }\n  /* mutated */'] as const;
const M_ENDPOINT_APPROVED_PROD = ["  if (namesProduction(approved)) refuse(RULES.APPROVED_IS_PROD, APPROVED_HOST_VARIABLE, 'names a production Redis; refused');\n  if (host !== approved)", '  if (host !== approved)'] as const;

function endpointControl(name: string, mutations: ReadonlyArray<readonly [string, string]>, env: Env): void {
  assert.throws(() => guard.resolveAuthE2ETarget(env), guard.E2EEnvironmentError, `${name}: the real guard must refuse`);
  const { mod, done } = mutantRule(mutations);
  try {
    const m = mod as unknown as { assertRedisEndpoints: (e: Env, k?: string[]) => void };
    assert.doesNotThrow(() => m.assertRedisEndpoints(env, []), `${name}: with the rule removed the input must be accepted`);
  } finally {
    done();
  }
}

test('C3 CONTROL C1 the endpoint positive identification is load-bearing', () => {
  // A non-production name, so removing the not-approved refusal is the only change needed.
  endpointControl('ANALYTICS_REDIS_URL unapproved', [M_ENDPOINT_NOT_APPROVED], approvedEnv({ ANALYTICS_REDIS_URL: `redis://${UNAPPROVED}:6379` }));
});

test('C3 CONTROL C1 the endpoint production-identity check is load-bearing (prod identity under another domain)', () => {
  // Approved as itself so only the identity layers can refuse it.
  const host = 'right-treefrog-90757.evil.example';
  endpointControl('ANALYTICS_REDIS_URL prod identity', [M_ENDPOINT_PROD, M_ENDPOINT_APPROVED_PROD], hostedEnv({ ANALYTICS_REDIS_URL: `redis://${host}:6379`, E2E_REDIS_APPROVED_HOST: host }));
});
