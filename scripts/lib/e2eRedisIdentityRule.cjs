'use strict';
/**
 * THE Redis target rule for the auth E2E suite (round 26 / C3, owner decision: FAIL-CLOSED).
 *
 * One rule, used by BOTH consumers:
 *   - tests/auth/e2eEnvironmentGuard.ts (hosted mode; pure, no network), and
 *   - scripts/reset-auth-e2e-rate-limits.js (the only E2E component that WRITES to Redis).
 * It is plain CommonJS with node built-ins only, so the JS script can require it and the TS guard
 * can require it without a build step.
 *
 * Accepted targets:
 *   - LOOPBACK: the exact WHATWG hostnames 127.0.0.1, localhost, [::1] (the CI service container).
 *     Local mode of the guard keeps its own, stricter loopback rule on top of this.
 *   - HOSTED: ONLY a Redis that is POSITIVELY IDENTIFIED as the approved disposable instance:
 *       E2E_REDIS_URL's host must equal E2E_REDIS_APPROVED_HOST exactly, an optional
 *       E2E_REDIS_APPROVED_FINGERPRINT must match, and E2E_REDIS_IDENTITY_TOKEN must be supplied so
 *       the writer can verify the runtime marker (rule R-MARKER) before any write.
 *     Missing approval configuration is a refusal (fail closed). Anything else is refused.
 *
 * Production is refused regardless of hostname, in layers:
 *   R-PROD-IDENTITY       a known production identity in any form of any target variable;
 *   R-APPROVED-IS-PROD    the approved host is itself production (or a production-named variable's host);
 *   R-SAME-HOST-AS-PROD-VAR  the target shares its normalised host with a production-named variable
 *                         (REDIS_URL, UPSTASH_REDIS_REST_URL, ...) present in the environment;
 *   R-MARKER              at runtime, before any write, GET omnivyra:e2e:identity must equal the
 *                         run's token. Production never carries the marker.
 *
 * Review fixes (round 26 / C3 review):
 *   C1  every OTHER Redis-bearing variable (CREATOR_RENDER_REDIS_URL, UPSTASH_REDIS_URL,
 *       UPSTASH_REDIS_REST_URL, REDIS_PRIVATE_URL, REDIS_HOST/REDIS_PORT, unknown Redis-named URL/host
 *       variables) goes through assertRedisEndpoint: loopback, or exactly the approved host under a
 *       non-production name; production identities under any domain are refused.
 *   C2  a WRITER (options.requireMarker) needs the token, and so the runtime marker, on loopback too:
 *       a loopback port can be a tunnel to Production. scripts/seed-auth-e2e-redis-identity.js seeds
 *       the marker into the fresh, EMPTY disposable Redis.
 *   M1  a hosted value in REDIS_URL is R-NOT-APPROVED (only E2E_REDIS_URL may name a hosted Redis).
 *
 * Errors name the rule and the variable, NEVER a value (URL, host, user, password or token).
 */

const crypto = require('node:crypto');

/** Known production Upstash hosts (live: right-treefrog; earlier: noble-dane). */
const PRODUCTION_REDIS_HOSTS = Object.freeze(['right-treefrog-90757.upstash.io', 'noble-dane-77325.upstash.io']);
/** Production identities, matched as text in every form, whatever domain they appear under. */
const PRODUCTION_REDIS_IDENTITIES = Object.freeze(['right-treefrog-90757', 'noble-dane-77325']);
/** The production Supabase project ref (never part of a legitimate Redis target). */
const PRODUCTION_SUPABASE_REFS = Object.freeze(['klkiseupptzbecbxwrky']);

/** Variables that select the E2E Redis target, in precedence order. */
const REDIS_TARGET_VARIABLES = Object.freeze(['E2E_REDIS_URL', 'REDIS_URL']);
/** The only variable that may name a HOSTED (non-loopback) target. */
const HOSTED_TARGET_VARIABLE = 'E2E_REDIS_URL';
/**
 * Production variable names: what the app / worker read in production. When any is present, the
 * target must not share its normalised host (rule R-SAME-HOST-AS-PROD-VAR). REDIS_URL is one of
 * them, so a hosted target can never be supplied through it.
 */
const PRODUCTION_REDIS_REFERENCE_VARIABLES = Object.freeze([
  'REDIS_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_URL', 'REDIS_PRIVATE_URL', 'CREATOR_RENDER_REDIS_URL', 'REDIS_HOST',
]);

const APPROVED_HOST_VARIABLE = 'E2E_REDIS_APPROVED_HOST';
const APPROVED_FINGERPRINT_VARIABLE = 'E2E_REDIS_APPROVED_FINGERPRINT';
const IDENTITY_TOKEN_VARIABLE = 'E2E_REDIS_IDENTITY_TOKEN';
/** Runtime identity marker key. Written ONLY into the disposable Redis when it is provisioned. */
const IDENTITY_MARKER_KEY = 'omnivyra:e2e:identity';
const MIN_TOKEN_LENGTH = 24;

const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
const APPROVED_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const PLACEHOLDER_MARKERS = Object.freeze(['placeholder', 'changeme', 'dry-run', 'example', 'your-']);

/** Invisible / format code points a parser or resolver may drop (soft hyphen, zero-width, BOM, ...). */
const INVISIBLE_CODE_POINTS = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

const RULES = Object.freeze({
  PROD_IDENTITY: 'R-PROD-IDENTITY',
  APPROVED_IS_PROD: 'R-APPROVED-IS-PROD',
  SAME_HOST_AS_PROD_VAR: 'R-SAME-HOST-AS-PROD-VAR',
  NOT_APPROVED: 'R-NOT-APPROVED',
  APPROVAL_MISSING: 'R-APPROVAL-MISSING',
  FINGERPRINT: 'R-FINGERPRINT',
  MARKER: 'R-MARKER',
  MALFORMED: 'R-MALFORMED',
  AMBIGUOUS: 'R-AMBIGUOUS',
});

class RedisRuleError extends Error {
  constructor(rule, variable, reason) {
    super(`${variable} ${reason} (rule ${rule})`);
    this.name = 'RedisRuleError';
    this.rule = rule;
    this.variable = variable;
  }
}

function refuse(rule, variable, reason) {
  throw new RedisRuleError(rule, variable, reason);
}

function safeDecode(text) {
  let current = text;
  for (let i = 0; i < 4; i += 1) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

function clean(s) {
  return String(s).normalize('NFKC').replace(INVISIBLE_CODE_POINTS, '').toLowerCase();
}

/**
 * Every form of a value a consumer could end up using: raw text, percent-decoded text, and (when it
 * parses as a URL) the WHATWG hostname and the decoded user, password, path, query and fragment.
 * Each is NFKC-normalised, stripped of invisible code points and lower-cased. Never logged.
 */
function denialCandidates(value) {
  const out = new Set();
  const add = (s) => {
    if (s) out.add(clean(s));
  };
  add(value);
  add(safeDecode(value));
  for (const candidate of [value, safeDecode(value)]) {
    try {
      const u = new URL(String(candidate).normalize('NFKC').replace(INVISIBLE_CODE_POINTS, ''));
      add(u.hostname);
      add(safeDecode(u.username));
      add(safeDecode(u.password));
      add(safeDecode(u.pathname));
      add(safeDecode(u.search));
      add(safeDecode(u.hash));
    } catch {
      // not a URL in this form; the text forms above still apply
    }
  }
  return [...out];
}

/** True when any form of the value names a production identity (Redis or Supabase). */
function namesProduction(value) {
  const forms = denialCandidates(value);
  return [...PRODUCTION_REDIS_IDENTITIES, ...PRODUCTION_REDIS_HOSTS, ...PRODUCTION_SUPABASE_REFS].some((m) => forms.some((f) => f.includes(m)));
}

/**
 * Normalised host of a URL (any scheme: redis, rediss, https REST) or of a bare host[:port]:
 * NFKC, invisible code points removed, percent-decoded, lower-case, trailing dots removed.
 * null when no host can be derived.
 */
function hostKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const s = safeDecode(String(value).normalize('NFKC').replace(INVISIBLE_CODE_POINTS, '').trim());
  let host = '';
  try {
    host = new URL(s).hostname;
  } catch {
    host = '';
  }
  if (!host) {
    try {
      host = new URL(`redis://${s}`).hostname;
    } catch {
      host = '';
    }
  }
  host = host.toLowerCase().replace(/\.+$/, '');
  return host || null;
}

/** sha256 hex of "<host>\n<port>\n<username>" (never the password). Port defaults to 6379. */
function redisIdentityFingerprint(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  const port = u.port || '6379';
  const user = safeDecode(u.username);
  return crypto.createHash('sha256').update(`${host}\n${port}\n${user}`).digest('hex');
}

function present(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function digestEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * Resolves and validates the E2E Redis target from an environment. Pure: no I/O, no network.
 *
 * options.required: refuse when no target variable is set (the reset script); otherwise return null.
 * options.requireMarker: the caller WRITES; a token (and so the runtime marker check) is required for
 *   every target, loopback included (review C2).
 * Returns { variable, url, host, kind: 'loopback' | 'hosted', markerToken: string | null }.
 * markerToken non-null means the writer MUST verify the runtime marker before any write.
 */
function resolveRedisTarget(env, options = {}) {
  const set = REDIS_TARGET_VARIABLES.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name]]);
  for (const [name, value] of set) {
    if (value.trim() === '') refuse(RULES.MALFORMED, name, 'is set but blank; refused rather than falling back');
  }
  // (a) Production identity first, in every target variable that is set, before anything else.
  for (const [name, value] of set) {
    if (namesProduction(value)) refuse(RULES.PROD_IDENTITY, name, 'points at production; refused');
  }
  if (set.length === 0) {
    if (options.required) refuse(RULES.APPROVAL_MISSING, REDIS_TARGET_VARIABLES.join('/'), 'is not configured; no Redis target is guessed');
    return null;
  }
  if (set.length === 2 && set[0][1].trim() !== set[1][1].trim()) {
    refuse(RULES.AMBIGUOUS, REDIS_TARGET_VARIABLES.join(' and '), 'are both set to different values; ambiguous target');
  }
  const [variable, raw] = set[0];
  const url = raw.trim();
  // On the RAW value: surrounding whitespace, backslashes and a second "@" are refused, not trimmed.
  if (/[\s\\]/.test(raw) || url.split('@').length > 2) refuse(RULES.MALFORMED, variable, 'contains characters that URL parsers interpret differently');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return refuse(RULES.MALFORMED, variable, 'is not a parseable URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') refuse(RULES.MALFORMED, variable, 'is not a redis:// or rediss:// URL');
  if (!parsed.hostname) refuse(RULES.MALFORMED, variable, 'has no host');
  if (parsed.search || parsed.hash) refuse(RULES.MALFORMED, variable, 'carries a query string or fragment');
  const host = parsed.hostname.toLowerCase();

  const tokenRaw = env[IDENTITY_TOKEN_VARIABLE];
  const token = typeof tokenRaw === 'string' && tokenRaw.trim() !== '' ? tokenRaw.trim() : null;
  const checkToken = () => {
    if (token === null) return;
    if (token.length < MIN_TOKEN_LENGTH) refuse(RULES.APPROVAL_MISSING, IDENTITY_TOKEN_VARIABLE, `is shorter than ${MIN_TOKEN_LENGTH} characters`);
    if (PLACEHOLDER_MARKERS.some((m) => token.toLowerCase().includes(m))) refuse(RULES.APPROVAL_MISSING, IDENTITY_TOKEN_VARIABLE, 'looks like a placeholder');
  };

  if (LOOPBACK_HOSTS.includes(host)) {
    // Review C2: a loopback port can be a tunnel to Production. A WRITER (options.requireMarker) must
    // therefore prove the identity marker on loopback too; a missing token is a refusal (fail closed).
    if (options.requireMarker && token === null) {
      refuse(RULES.APPROVAL_MISSING, IDENTITY_TOKEN_VARIABLE, 'is not set; a writer must verify the identity marker before any write, on loopback too (seed it with npm run seed:auth-e2e-redis-identity)');
    }
    checkToken();
    return { variable, url, host, kind: 'loopback', markerToken: token };
  }

  // ---------------- HOSTED: positive identification only ----------------
  // Only E2E_REDIS_URL may name a hosted Redis (REDIS_URL is a production variable name). (Review M1:
  // this is reported as R-NOT-APPROVED, before any same-host comparison.)
  if (variable !== HOSTED_TARGET_VARIABLE) refuse(RULES.NOT_APPROVED, variable, `names a hosted Redis that is not approved; a hosted E2E Redis may only be named by ${HOSTED_TARGET_VARIABLE}`);
  // (c) The target must not share its host with a production-named variable that is present.
  for (const name of PRODUCTION_REDIS_REFERENCE_VARIABLES) {
    const ref = present(env, name);
    if (ref === null) continue;
    if (hostKey(ref) === hostKey(url)) {
      refuse(RULES.SAME_HOST_AS_PROD_VAR, variable, `shares its host with the production variable ${name}; a production host is never the disposable E2E Redis`);
    }
  }

  const approvedRaw = env[APPROVED_HOST_VARIABLE];
  if (typeof approvedRaw !== 'string' || approvedRaw.trim() === '') {
    refuse(RULES.APPROVAL_MISSING, APPROVED_HOST_VARIABLE, 'is not set; a hosted Redis is accepted only when positively identified');
  }
  const approved = approvedRaw.trim();
  // (b) The approval itself must not name production (a misconfiguration), in any form.
  if (namesProduction(approved)) refuse(RULES.APPROVED_IS_PROD, APPROVED_HOST_VARIABLE, 'names a production Redis; refused');
  for (const name of PRODUCTION_REDIS_REFERENCE_VARIABLES) {
    const ref = present(env, name);
    if (ref !== null && hostKey(ref) === hostKey(approved)) refuse(RULES.APPROVED_IS_PROD, APPROVED_HOST_VARIABLE, `equals the host of the production variable ${name}; refused`);
  }
  if (!APPROVED_HOST_PATTERN.test(approved)) refuse(RULES.APPROVAL_MISSING, APPROVED_HOST_VARIABLE, 'is not an exact lower-case host name (no scheme, port, user-info or trailing dot)');
  if (LOOPBACK_HOSTS.includes(approved)) refuse(RULES.APPROVAL_MISSING, APPROVED_HOST_VARIABLE, 'must name a hosted instance, not loopback');

  // Positive identification: exact host equality, nothing else.
  if (host !== approved) refuse(RULES.NOT_APPROVED, variable, `is not the approved disposable Redis named by ${APPROVED_HOST_VARIABLE}`);

  const fpRaw = env[APPROVED_FINGERPRINT_VARIABLE];
  if (typeof fpRaw === 'string') {
    const fp = fpRaw.trim().toLowerCase();
    if (!FINGERPRINT_PATTERN.test(fp)) refuse(RULES.FINGERPRINT, APPROVED_FINGERPRINT_VARIABLE, 'is not a sha256 hex digest');
    if (!digestEqual(fp, redisIdentityFingerprint(url))) refuse(RULES.FINGERPRINT, variable, `does not match ${APPROVED_FINGERPRINT_VARIABLE} (host, port, user)`);
  }

  if (token === null) refuse(RULES.APPROVAL_MISSING, IDENTITY_TOKEN_VARIABLE, 'is not set; a hosted Redis must prove its identity marker before any write');
  checkToken();
  return { variable, url, host, kind: 'hosted', markerToken: token };
}

/**
 * Redis endpoint variables OTHER than the targets that the app under test (or its libraries) may read.
 * In hosted mode each must be loopback or the approved disposable host (review C1).
 */
const REDIS_ENDPOINT_VARIABLES = Object.freeze([
  'CREATOR_RENDER_REDIS_URL', 'REDIS_PRIVATE_URL', 'UPSTASH_REDIS_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_HOST',
]);
/** The rule's own configuration (validated by resolveRedisTarget, never treated as an endpoint). */
const REDIS_CONFIG_VARIABLES = Object.freeze([APPROVED_HOST_VARIABLE, APPROVED_FINGERPRINT_VARIABLE, IDENTITY_TOKEN_VARIABLE]);
/** Redis-bearing variable names (for names the guard does not know individually). */
const REDIS_NAME_PATTERN = /(REDIS|UPSTASH|^KV_)/i;
/** An unknown Redis-named variable is treated as an endpoint when its name or value says so. */
const ENDPOINT_NAME_SUFFIX = /(URL|URI|HOST|ENDPOINT|ADDR|ADDRESS|DSN|SERVER)$/i;

/** Loopback decided on the RAW value (no NFKC, no decoding), so only what a client would also see as loopback passes. */
function isRawLoopback(value) {
  const raw = String(value).trim();
  if (/[\s\\]/.test(raw) || raw.split('@').length > 2) return false;
  let host = '';
  if (raw.includes('://')) {
    try {
      const u = new URL(raw);
      if (u.search || u.hash) return false;
      host = u.hostname.toLowerCase();
    } catch {
      return false;
    }
  } else {
    // A bare host (REDIS_HOST), optionally with a :port.
    host = raw.toLowerCase();
    const hostPort = /^([^:[\]]+):\d{1,5}$/.exec(host) || /^(\[[^\]]+\]):\d{1,5}$/.exec(host);
    if (hostPort) host = hostPort[1];
    if (host === '::1') host = '[::1]';
  }
  return LOOPBACK_HOSTS.includes(host);
}

/**
 * Review C1: validates ONE non-target Redis endpoint variable (hosted mode). Pure; no network.
 * Accepted: loopback, or exactly the approved disposable host under a NON-production name.
 * Everything else is refused: a production identity in any form (any domain), an unapproved host,
 * missing approval configuration, the approved host under a production variable name.
 */
function assertRedisEndpoint(name, value, env) {
  if (typeof value !== 'string' || value.trim() === '') return;
  if (name === 'REDIS_PORT') {
    if (!/^\d{1,5}$/.test(value.trim())) refuse(RULES.MALFORMED, name, 'is not a port number');
    return;
  }
  if (namesProduction(value)) refuse(RULES.PROD_IDENTITY, name, 'points at production; refused');
  if (isRawLoopback(value)) return;
  const host = hostKey(value);
  if (host === null) refuse(RULES.MALFORMED, name, 'has no derivable host');
  const approvedRaw = env[APPROVED_HOST_VARIABLE];
  const approved = typeof approvedRaw === 'string' ? approvedRaw.trim() : '';
  if (!approved) refuse(RULES.APPROVAL_MISSING, name, `names a hosted Redis and ${APPROVED_HOST_VARIABLE} is not set; only loopback or the approved disposable Redis is accepted`);
  if (namesProduction(approved)) refuse(RULES.APPROVED_IS_PROD, APPROVED_HOST_VARIABLE, 'names a production Redis; refused');
  if (host !== approved) refuse(RULES.NOT_APPROVED, name, `names a hosted Redis that is not the approved disposable Redis named by ${APPROVED_HOST_VARIABLE}`);
  if (PRODUCTION_REDIS_REFERENCE_VARIABLES.includes(name)) {
    refuse(RULES.SAME_HOST_AS_PROD_VAR, name, 'is a production variable name; the approved disposable Redis may only be named by E2E_REDIS_URL');
  }
}

/**
 * Review C1: which variables of an environment are Redis endpoints to validate with assertRedisEndpoint.
 * known: names the caller validates elsewhere or knows are not endpoints (e.g. limits, switches).
 */
function redisEndpointVariables(env, known = []) {
  const out = [];
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (REDIS_TARGET_VARIABLES.includes(name) || REDIS_CONFIG_VARIABLES.includes(name)) continue;
    if (REDIS_ENDPOINT_VARIABLES.includes(name) || name === 'REDIS_PORT') {
      out.push(name);
      continue;
    }
    if (known.includes(name) || !REDIS_NAME_PATTERN.test(name)) continue;
    if (ENDPOINT_NAME_SUFFIX.test(name) || value.includes('://')) out.push(name);
  }
  return out;
}

/** Applies assertRedisEndpoint to every Redis endpoint variable of env (hosted mode). */
function assertRedisEndpoints(env, known = []) {
  for (const name of redisEndpointVariables(env, known)) assertRedisEndpoint(name, env[name], env);
}

/**
 * (d) Runtime identity check. Call AFTER connecting and BEFORE any write. `client.get` is the only
 * command issued. An absent or mismatching marker is a refusal; values are never echoed.
 */
async function assertRedisIdentityMarker(client, expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken === '') refuse(RULES.MARKER, IDENTITY_TOKEN_VARIABLE, 'is not available for the identity check');
  let value;
  try {
    value = await client.get(IDENTITY_MARKER_KEY);
  } catch {
    return refuse(RULES.MARKER, IDENTITY_MARKER_KEY, 'could not be read; the target is not proven to be the disposable Redis');
  }
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) refuse(RULES.MARKER, IDENTITY_MARKER_KEY, 'is absent; the target is not the provisioned disposable Redis');
  if (!digestEqual(String(value), expectedToken)) refuse(RULES.MARKER, IDENTITY_MARKER_KEY, 'does not match the run token; the target is not the provisioned disposable Redis');
}

module.exports = {
  PRODUCTION_REDIS_HOSTS,
  PRODUCTION_REDIS_IDENTITIES,
  PRODUCTION_SUPABASE_REFS,
  REDIS_TARGET_VARIABLES,
  HOSTED_TARGET_VARIABLE,
  PRODUCTION_REDIS_REFERENCE_VARIABLES,
  APPROVED_HOST_VARIABLE,
  APPROVED_FINGERPRINT_VARIABLE,
  IDENTITY_TOKEN_VARIABLE,
  IDENTITY_MARKER_KEY,
  LOOPBACK_HOSTS,
  RULES,
  RedisRuleError,
  denialCandidates,
  namesProduction,
  hostKey,
  redisIdentityFingerprint,
  resolveRedisTarget,
  assertRedisIdentityMarker,
  REDIS_ENDPOINT_VARIABLES,
  REDIS_CONFIG_VARIABLES,
  isRawLoopback,
  assertRedisEndpoint,
  redisEndpointVariables,
  assertRedisEndpoints,
};

// Provisioning helper: prints ONLY the fingerprint (a hash) of E2E_REDIS_URL, never the URL.
if (require.main === module) {
  const url = process.env.E2E_REDIS_URL;
  if (!url) {
    console.error('E2E_REDIS_URL is not set');
    process.exit(1);
  }
  console.log(redisIdentityFingerprint(url));
}
