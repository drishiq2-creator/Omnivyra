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
 * The target is validated BEFORE ioredis is even loaded, by THE shared rule
 * scripts/lib/e2eRedisIdentityRule.cjs (the same rule the E2E guard uses), so a refused target can
 * never receive a connection, SCAN or DEL. FAIL-CLOSED (round 26 / C3):
 *   - loopback (127.0.0.1, localhost, [::1]) is accepted;
 *   - a hosted Redis is accepted ONLY when positively identified: E2E_REDIS_URL's host equals
 *     E2E_REDIS_APPROVED_HOST (and E2E_REDIS_APPROVED_FINGERPRINT, when set) and
 *     E2E_REDIS_IDENTITY_TOKEN is supplied; missing approval configuration is a refusal;
 *   - production is refused regardless of hostname: known production identities in every form,
 *     an approval that names production, and a host shared with a production-named variable;
 *   - before ANY write, on EVERY target (loopback included: a loopback port can be a tunnel to
 *     Production; review C2), GET omnivyra:e2e:identity must equal E2E_REDIS_IDENTITY_TOKEN; a missing
 *     token or marker is a refusal. The marker is seeded into the fresh disposable Redis by
 *     scripts/seed-auth-e2e-redis-identity.js (production never carries it);
 *   - a malformed, blank, non-redis or ambiguous target is refused rather than guessed;
 *   - messages name the rule and the variable, never a value.
 * Only keys under the `rl:*` auth rate-limit namespaces listed below are deleted; the database is
 * never flushed. (In CI the workflows additionally pin the loopback Redis service container.)
 */

const path = require('path');

// THE Redis target rule, shared with tests/auth/e2eEnvironmentGuard.ts (one rule, not two copies).
const redisRule = require('./lib/e2eRedisIdentityRule.cjs');

const PRODUCTION_REDIS_HOSTS = redisRule.PRODUCTION_REDIS_HOSTS;
const PRODUCTION_MARKERS = [...redisRule.PRODUCTION_REDIS_IDENTITIES, ...redisRule.PRODUCTION_REDIS_HOSTS, ...redisRule.PRODUCTION_SUPABASE_REFS];
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

class ResetRefusedError extends Error {
  constructor(message) {
    super(`[auth-e2e rate-limit reset] REFUSING: ${message}`);
    this.name = 'ResetRefusedError';
  }
}

function asRefusal(error) {
  return error instanceof redisRule.RedisRuleError ? new ResetRefusedError(error.message) : error;
}

/**
 * Validates the reset target from the given environment and returns it. Throws ResetRefusedError on
 * any doubt. Pure: no I/O, no network.
 */
function resolveResetTarget(env) {
  let target;
  try {
    target = redisRule.resolveRedisTarget(env, { required: true, requireMarker: true });
  } catch (error) {
    throw asRefusal(error);
  }
  return { variable: target.variable, url: target.url };
}

/** Full resolution, including the kind and the identity token the writer must verify. */
function resolveResetTargetWithIdentity(env) {
  try {
    return redisRule.resolveRedisTarget(env, { required: true, requireMarker: true });
  } catch (error) {
    throw asRefusal(error);
  }
}

function defaultCreateRedis(url) {
  const IORedis = require(path.join(process.cwd(), 'node_modules', 'ioredis'));
  return new IORedis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
}

async function main({ env = process.env, createRedis = defaultCreateRedis, log = console.log } = {}) {
  // Validation happens BEFORE any Redis client exists.
  const target = resolveResetTargetWithIdentity(env);
  const redis = createRedis(target.url);

  let deleted = 0;
  try {
    await redis.connect();
    // (d) Runtime identity: before ANY write, the disposable Redis must carry the run's marker.
    // resolveResetTargetWithIdentity guarantees a token for every target (fail closed).
    try {
      await redisRule.assertRedisIdentityMarker(redis, target.markerToken);
    } catch (error) {
      throw asRefusal(error);
    }
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

module.exports = { PRODUCTION_REDIS_HOSTS, PRODUCTION_MARKERS, RATE_LIMIT_PREFIXES, ResetRefusedError, resolveResetTarget, resolveResetTargetWithIdentity, main };

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
