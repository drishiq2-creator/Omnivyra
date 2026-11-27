#!/usr/bin/env node
/**
 * Resets the auth rate-limit counters in the E2E Redis instance.
 *
 * WHY
 * ---
 * `lib/auth/rateLimit.ts` enforces LOGIN_LIMIT = 10 sign-ins per IP per 15
 * minutes, backed by a Redis sliding window keyed `rl:login:<ip>`. The
 * Auth-Integrity suite performs ~5 password logins per full run, all from a
 * single IP, so three consecutive runs inside one 15-minute window exceed the
 * cap and the app correctly returns HTTP 429.
 *
 * That is the production security control behaving as designed. Rather than
 * weaken it, the E2E harness clears the counters BETWEEN runs — the limiter
 * stays fully active within each run.
 *
 * SAFETY
 * ------
 * The target is validated BEFORE ioredis is even loaded, so a refused target can never
 * receive a connection, SCAN or DEL:
 *   - both production Redis hosts and the production Supabase project are refused, in every
 *     form (case, port, user-info, trailing dot, percent-encoding, full-width or invisible
 *     characters);
 *   - a malformed, blank, non-redis or ambiguous target (E2E_REDIS_URL and REDIS_URL both set
 *     to different values) is refused rather than guessed;
 *   - messages name the variable, never its value.
 * Only keys under the `rl:*` auth rate-limit namespaces listed below are deleted; the database is
 * never flushed. (In CI the workflows additionally pin the loopback Redis service container.)
 */

const path = require('path');

/**
 * Production Redis hosts. Keep in step with PRODUCTION_REDIS_HOSTNAMES in
 * tests/auth/e2eEnvironmentGuard.ts (a test enforces that this list covers it).
 */
const PRODUCTION_REDIS_HOSTS = ['right-treefrog-90757.upstash.io', 'noble-dane-77325.upstash.io'];
const PRODUCTION_MARKERS = [...PRODUCTION_REDIS_HOSTS, 'klkiseupptzbecbxwrky'];
const RATE_LIMIT_PREFIXES = [
  'rl:login',
  'rl:otp_send',
  'rl:otp_verify',
  'rl:email_link',
  'rl:onboarding',
  'rl:uid:onboarding',
  'rl:uid:invite',
  'rl:domain_resolution',
];
const TARGET_VARIABLES = ['E2E_REDIS_URL', 'REDIS_URL'];
const INVISIBLE_CODE_POINTS = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

class ResetRefusedError extends Error {
  constructor(message) {
    super(`[auth-e2e rate-limit reset] REFUSING: ${message}`);
    this.name = 'ResetRefusedError';
  }
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

/** Every form a consumer could end up using, normalised for matching (never logged). */
function candidateForms(value) {
  const out = new Set();
  const add = (s) => {
    if (s) out.add(String(s).normalize('NFKC').replace(INVISIBLE_CODE_POINTS, '').toLowerCase());
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
    } catch {
      // not a URL in this form; the text forms above still apply
    }
  }
  return [...out];
}

/**
 * Validates the reset target from the given environment and returns it. Throws ResetRefusedError on
 * any doubt. Pure: no I/O, no network.
 */
function resolveResetTarget(env) {
  const set = TARGET_VARIABLES.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name]]);
  for (const [name, value] of set) {
    if (value.trim() === '') throw new ResetRefusedError(`${name} is set but blank.`);
  }
  // Production first, in every variable that is set, before anything else is decided.
  for (const [name, value] of set) {
    const forms = candidateForms(value);
    for (const marker of PRODUCTION_MARKERS) {
      if (forms.some((f) => f.includes(marker))) throw new ResetRefusedError(`${name} points at production; refused.`);
    }
  }
  if (set.length === 0) throw new ResetRefusedError('no E2E_REDIS_URL/REDIS_URL configured.');
  if (set.length === 2 && set[0][1].trim() !== set[1][1].trim()) {
    throw new ResetRefusedError('E2E_REDIS_URL and REDIS_URL are both set to different values; ambiguous target.');
  }
  const [name, raw] = set[0];
  const value = raw.trim();
  // Checked on the RAW value: surrounding whitespace is refused too, not silently trimmed.
  if (/[\s\\]/.test(raw) || value.split('@').length > 2) {
    throw new ResetRefusedError(`${name} contains characters that URL parsers interpret differently.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ResetRefusedError(`${name} is not a parseable URL.`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') throw new ResetRefusedError(`${name} is not a redis:// or rediss:// URL.`);
  if (!parsed.hostname) throw new ResetRefusedError(`${name} has no host.`);
  if (parsed.search || parsed.hash) throw new ResetRefusedError(`${name} carries a query string or fragment.`);
  return { variable: name, url: value };
}

function defaultCreateRedis(url) {
  const IORedis = require(path.join(process.cwd(), 'node_modules', 'ioredis'));
  return new IORedis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
}

async function main({ env = process.env, createRedis = defaultCreateRedis, log = console.log } = {}) {
  // Validation happens BEFORE any Redis client exists.
  const target = resolveResetTarget(env);
  const redis = createRedis(target.url);

  let deleted = 0;
  try {
    await redis.connect();
    for (const prefix of RATE_LIMIT_PREFIXES) {
      // Scoped SCAN + DEL. Never FLUSHDB.
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
    }
    log(`[auth-e2e rate-limit reset] cleared ${deleted} auth rate-limit key(s)`);
  } finally {
    try {
      redis.disconnect();
    } catch {
      /* ignore */
    }
  }
  return deleted;
}

module.exports = { PRODUCTION_REDIS_HOSTS, PRODUCTION_MARKERS, RATE_LIMIT_PREFIXES, ResetRefusedError, resolveResetTarget, main };

if (require.main === module) {
  const ENV_FILE = process.env.AUTH_E2E_ENV_FILE || '.env.e2e';
  try {
    const fs = require('fs');
    if (fs.existsSync(ENV_FILE)) {
      require('dotenv').config({ path: ENV_FILE, override: true });
    }
  } catch {
    /* dotenv optional */
  }
  main().catch((error) => {
    console.error(error instanceof ResetRefusedError ? error.message : `[auth-e2e rate-limit reset] ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}
