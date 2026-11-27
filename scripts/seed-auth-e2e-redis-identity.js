#!/usr/bin/env node
/**
 * Seeds the E2E Redis identity marker (round 26 / C3, review C2).
 *
 * The rate-limit reset (scripts/reset-auth-e2e-rate-limits.js) writes only after it has read
 * `omnivyra:e2e:identity` and found it equal to E2E_REDIS_IDENTITY_TOKEN, on loopback too (a loopback
 * port can be a tunnel to Production). This script puts that marker into the FRESH disposable Redis,
 * right after it is started.
 *
 * SAFETY (the seed is itself a write, so it is fail-closed as well):
 *   - the target is resolved by THE shared rule (scripts/lib/e2eRedisIdentityRule.cjs) BEFORE any
 *     client exists: production in any form is refused; a hosted Redis must be the approved one;
 *   - it seeds only an EMPTY database (DBSIZE 0) that has no marker yet, with SET NX. A fresh
 *     disposable Redis is empty; Production never is, so Production can never be marked;
 *   - re-running with the same token on an already-seeded Redis is a no-op (local developer reuse);
 *     a different marker is a refusal;
 *   - the token is never printed. With --env-out FILE and no E2E_REDIS_IDENTITY_TOKEN, a random
 *     per-run token is generated and appended to FILE as E2E_REDIS_IDENTITY_TOKEN=... (in GitHub
 *     Actions, FILE is $GITHUB_ENV and the token is masked first).
 *
 * Usage:
 *   CI:    node scripts/seed-auth-e2e-redis-identity.js --env-out "$GITHUB_ENV"
 *   local: npm run seed:auth-e2e-redis-identity -- --env-out .e2e-redis-identity.env
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const redisRule = require('./lib/e2eRedisIdentityRule.cjs');

class SeedRefusedError extends Error {
  constructor(message) {
    super(`[auth-e2e redis identity seed] REFUSING: ${message}`);
    this.name = 'SeedRefusedError';
  }
}

function asRefusal(error) {
  return error instanceof redisRule.RedisRuleError ? new SeedRefusedError(error.message) : error;
}

function parseArgs(argv) {
  const out = { envOut: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env-out') {
      out.envOut = argv[i + 1] || null;
      i += 1;
      if (!out.envOut) throw new SeedRefusedError('--env-out needs a file path.');
    } else {
      throw new SeedRefusedError('unknown argument (only --env-out FILE is accepted).');
    }
  }
  return out;
}

function defaultCreateRedis(url) {
  const IORedis = require(path.join(process.cwd(), 'node_modules', 'ioredis'));
  return new IORedis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
}

async function seed({ env = process.env, argv = [], createRedis = defaultCreateRedis, log = console.log, appendFile = fs.appendFileSync } = {}) {
  const args = parseArgs(argv);
  let token = typeof env[redisRule.IDENTITY_TOKEN_VARIABLE] === 'string' && env[redisRule.IDENTITY_TOKEN_VARIABLE].trim() !== ''
    ? env[redisRule.IDENTITY_TOKEN_VARIABLE].trim()
    : null;
  let generated = false;
  if (token === null) {
    if (!args.envOut) throw new SeedRefusedError(`${redisRule.IDENTITY_TOKEN_VARIABLE} is not set; pass --env-out FILE to generate a per-run token.`);
    token = crypto.randomBytes(24).toString('hex');
    generated = true;
  }
  // Validation (shared rule) BEFORE any client exists.
  let target;
  try {
    target = redisRule.resolveRedisTarget({ ...env, [redisRule.IDENTITY_TOKEN_VARIABLE]: token }, { required: true, requireMarker: true });
  } catch (error) {
    throw asRefusal(error);
  }

  const redis = createRedis(target.url);
  let outcome;
  try {
    await redis.connect();
    const existing = await redis.get(redisRule.IDENTITY_MARKER_KEY);
    if (existing !== null && existing !== undefined) {
      try {
        await redisRule.assertRedisIdentityMarker({ get: async () => existing }, token);
      } catch {
        throw new SeedRefusedError(`${redisRule.IDENTITY_MARKER_KEY} already holds a different marker; this Redis belongs to another run (rule ${redisRule.RULES.MARKER}).`);
      }
      outcome = 'already-seeded';
    } else {
      const size = Number(await redis.dbsize());
      if (!Number.isInteger(size) || size !== 0) {
        throw new SeedRefusedError('the target Redis is not empty; only a fresh disposable Redis is ever seeded (Production is never empty) (rule R-SEED-NOT-EMPTY).');
      }
      const ok = await redis.set(redisRule.IDENTITY_MARKER_KEY, token, 'NX');
      if (ok !== 'OK') throw new SeedRefusedError(`${redisRule.IDENTITY_MARKER_KEY} could not be set (SET NX did not succeed) (rule ${redisRule.RULES.MARKER}).`);
      outcome = 'seeded';
    }
  } finally {
    try {
      redis.disconnect();
    } catch {
      /* ignore */
    }
  }
  if (generated) {
    if (env.GITHUB_ACTIONS === 'true') log(`::add-mask::${token}`);
    appendFile(args.envOut, `${redisRule.IDENTITY_TOKEN_VARIABLE}=${token}\n`);
  }
  log(`[auth-e2e redis identity seed] ${outcome === 'seeded' ? 'identity marker seeded' : 'identity marker already present for this token'} (${target.kind} target ${target.variable}${generated ? '; token written to --env-out' : ''})`);
  return outcome;
}

module.exports = { SeedRefusedError, seed };

if (require.main === module) {
  // Same env-file behaviour as the reset script, so both see the same target.
  const ENV_FILE = process.env.AUTH_E2E_ENV_FILE || '.env.e2e';
  try {
    if (fs.existsSync(ENV_FILE)) require('dotenv').config({ path: ENV_FILE, override: true });
  } catch {
    /* dotenv optional */
  }
  seed({ argv: process.argv.slice(2) }).catch((error) => {
    console.error(error instanceof SeedRefusedError ? error.message : `[auth-e2e redis identity seed] ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}
