/**
 * scripts/reset-auth-e2e-rate-limits.js (review item: stale production Redis marker).
 * The script SCANs and DELs rl:* keys, so a production target must be refused BEFORE any Redis
 * client exists. Unit tests on the pure validator, an in-process test with an injected client, and
 * child-process runs of the real script with the network trapped. Every rule has a failing control.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { PRODUCTION_REDIS_HOSTNAMES } from '../auth/e2eEnvironmentGuard';

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'reset-auth-e2e-rate-limits.js');
type ResetModule = {
  PRODUCTION_REDIS_HOSTS: string[];
  RATE_LIMIT_PREFIXES: string[];
  ResetRefusedError: new (m: string) => Error;
  resolveResetTarget: (env: Record<string, string | undefined>) => { variable: string; url: string };
  main: (o: { env?: Record<string, string | undefined>; createRedis?: (url: string) => unknown; log?: (m: string) => void }) => Promise<number>;
};
const load = (file: string): ResetModule => createRequire(__filename)(file) as ResetModule;
const reset = load(SCRIPT);

const LIVE = 'right-treefrog-90757.upstash.io';
const STALE = 'noble-dane-77325.upstash.io';
const PW = 'fixture-redis-pw';
const LOOPBACK = 'redis://127.0.0.1:6379';
// Round 26 / C3 review C2: the reset writes only after proving the identity marker, on loopback too, so
// every accepted loopback case now carries the run token (the token is required; a missing one is refused).
const RUN_TOKEN = 'c3-run-token-0123456789abcdef';

function refused(env: Record<string, string | undefined>, why: string, mention?: RegExp): void {
  assert.throws(
    () => reset.resolveResetTarget(env),
    (e: unknown) => {
      assert.ok(e instanceof reset.ResetRefusedError, `${why}: wrong error ${String(e)}`);
      const m = (e as Error).message;
      assert.ok(!m.includes(PW) && !m.includes(LIVE) && !m.includes(STALE), `${why}: the message echoed the value`);
      if (mention) assert.match(m, mention, why);
      return true;
    },
    why,
  );
}

test('RESET the script refuses every production Redis host the E2E guard refuses (single source kept in step)', () => {
  for (const host of PRODUCTION_REDIS_HOSTNAMES) assert.ok(reset.PRODUCTION_REDIS_HOSTS.includes(host), `script lacks ${host}`);
  assert.ok(reset.PRODUCTION_REDIS_HOSTS.includes(LIVE) && reset.PRODUCTION_REDIS_HOSTS.includes(STALE));
});

test('RESET both production hosts are refused in every form and in both variables', () => {
  for (const host of [LIVE, STALE]) {
    for (const [why, url] of [
      ['plain', `rediss://default:${PW}@${host}:6379`],
      ['other port', `rediss://default:${PW}@${host}:6380`],
      ['no user-info', `rediss://${host}:6379`],
      ['upper case', `rediss://default:${PW}@${host.toUpperCase()}:6379`],
      ['trailing dot', `rediss://default:${PW}@${host}.:6379`],
      ['host inside user-info', `rediss://${host}:${PW}@cache.example.net:6379`],
      ['percent-encoded', `rediss://default:${PW}@${host.replace('-', '%2D')}:6379`],
      ['soft hyphen', `rediss://default:${PW}@${host.slice(0, 5)}­${host.slice(5)}:6379`],
      ['full-width first letter', `rediss://default:${PW}@${String.fromCharCode(host.charCodeAt(0) + 0xfee0)}${host.slice(1)}:6379`],
      ['unparseable', `rediss://default:${PW}@${host}:notaport`],
      ['no scheme', `${host}:6379`],
    ] as const) {
      refused({ REDIS_URL: url }, `${host} ${why} (REDIS_URL)`, /production/);
      refused({ E2E_REDIS_URL: url }, `${host} ${why} (E2E_REDIS_URL)`, /production/);
      refused({ E2E_REDIS_URL: LOOPBACK, REDIS_URL: url }, `${host} ${why} in the unused variable`, /production/);
    }
  }
  refused({ REDIS_URL: 'redis://127.0.0.1:6379/klkiseupptzbecbxwrky' }, 'the production Supabase ref', /production/);
});

test('RESET malformed, blank or ambiguous targets fail closed', () => {
  for (const [why, env] of [
    ['nothing set', {}],
    ['blank', { REDIS_URL: '   ' }],
    ['blank E2E', { E2E_REDIS_URL: '', REDIS_URL: LOOPBACK }],
    ['different values', { E2E_REDIS_URL: 'redis://127.0.0.1:6380', REDIS_URL: LOOPBACK }],
    ['unparseable', { REDIS_URL: 'not a url' }],
    ['wrong scheme', { REDIS_URL: 'http://127.0.0.1:6379' }],
    ['no host', { REDIS_URL: 'redis://' }],
    ['tab', { REDIS_URL: 'redis://127.0.0.1:6379\t' }],
    ['backslash', { REDIS_URL: 'redis://127.0.0.1:6379\\@evil.example' }],
    ['two @', { REDIS_URL: 'redis://a@evil.example:6379@127.0.0.1:6379' }],
    ['query', { REDIS_URL: 'redis://127.0.0.1:6379/0?host=evil.example' }],
  ] as const) {
    refused(env as Record<string, string>, why);
  }
});

test('RESET the loopback CI target is still accepted (hosted and local workflow shapes, with the run token)', () => {
  assert.deepEqual(reset.resolveResetTarget({ REDIS_URL: LOOPBACK, E2E_REDIS_IDENTITY_TOKEN: RUN_TOKEN }), { variable: 'REDIS_URL', url: LOOPBACK });
  assert.deepEqual(reset.resolveResetTarget({ E2E_REDIS_URL: LOOPBACK, REDIS_URL: LOOPBACK, E2E_REDIS_IDENTITY_TOKEN: RUN_TOKEN }), { variable: 'E2E_REDIS_URL', url: LOOPBACK });
  assert.equal(reset.resolveResetTarget({ REDIS_URL: 'redis://127.0.0.1:6379/0', E2E_REDIS_IDENTITY_TOKEN: RUN_TOKEN }).url, 'redis://127.0.0.1:6379/0');
  // C2: without the token, loopback is refused (a loopback port can be a tunnel to Production).
  refused({ REDIS_URL: LOOPBACK }, 'loopback without the run token', /R-APPROVAL-MISSING/);
});

/** A fake ioredis: records every call; SCAN honours MATCH so the deletion scope is observable. */
function fakeRedis(keys: string[]) {
  const calls: string[] = [];
  const store = new Set(keys);
  return {
    calls,
    store,
    client: {
      connect: async () => { calls.push('connect'); },
      scan: async (_cursor: string, _m: string, pattern: string) => {
        calls.push(`scan ${pattern}`);
        const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        return ['0', [...store].filter((k) => re.test(k))];
      },
      del: async (...ks: string[]) => { calls.push(`del ${ks.join(',')}`); for (const k of ks) store.delete(k); return ks.length; },
      disconnect: () => { calls.push('disconnect'); },
    },
  };
}

test('RESET a production target never creates a Redis client (no connect, SCAN or DEL)', async () => {
  for (const url of [`rediss://default:${PW}@${LIVE}:6379`, `rediss://default:${PW}@${STALE}:6379`]) {
    let created = 0;
    await assert.rejects(() => reset.main({ env: { REDIS_URL: url }, createRedis: () => { created += 1; return fakeRedis([]).client; }, log: () => undefined }), reset.ResetRefusedError);
    assert.equal(created, 0, 'no client may be created for a refused target');
  }
});

test('RESET on loopback only rl:* rate-limit keys in the listed namespaces are deleted', async () => {
  const f = fakeRedis(['rl:login:1.2.3.4', 'rl:otp_send:a', 'rl:uid:invite:u1', 'rl:other:x', 'session:abc', 'bull:queue:1']);
  const client = { ...f.client, get: async (key: string) => { f.calls.push(`get ${key}`); return RUN_TOKEN; } };
  const deleted = await reset.main({ env: { REDIS_URL: LOOPBACK, E2E_REDIS_IDENTITY_TOKEN: RUN_TOKEN }, createRedis: () => client, log: () => undefined });
  assert.equal(f.calls[1], 'get omnivyra:e2e:identity', 'the marker is read before any SCAN/DEL');
  assert.equal(deleted, 3);
  assert.deepEqual([...f.store].sort(), ['bull:queue:1', 'rl:other:x', 'session:abc']);
  assert.ok(!f.calls.some((c) => /flush/i.test(c)));
});

// ---------------- the real script, as a child process, with the network trapped ----------------
function runScript(script: string, env: Record<string, string>): { status: number | null; out: string; attempts: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-trap-'));
  try {
    const trapLog = path.join(dir, 'attempts.log');
    const trap = path.join(dir, 'trap.js');
    fs.writeFileSync(trapLog, '');
    fs.writeFileSync(trap, [
      "const fs = require('fs'); const net = require('net'); const dns = require('dns');",
      `const LOG = ${JSON.stringify(trapLog)};`,
      "net.Socket.prototype.connect = function () { fs.appendFileSync(LOG, 'connect\\n'); throw new Error('network trapped'); };",
      "dns.lookup = function () { fs.appendFileSync(LOG, 'lookup\\n'); throw new Error('network trapped'); };",
      '',
    ].join('\n'));
    const base: Record<string, string> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', AUTH_E2E_ENV_FILE: path.join(dir, 'no-such-env-file') };
    const r = spawnSync(process.execPath, ['--require', trap, script], { cwd: REPO, env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, attempts: fs.readFileSync(trapLog, 'utf8').split('\n').filter(Boolean).length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('RESET the real script refuses both production hosts with exit 1 and zero network attempts', () => {
  for (const host of [LIVE, STALE]) {
    const r = runScript(SCRIPT, { REDIS_URL: `rediss://default:${PW}@${host}:6379` });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /REFUSING: REDIS_URL points at production/);
    assert.equal(r.attempts, 0, 'no connection or DNS lookup may be attempted');
    assert.ok(!r.out.includes(PW) && !r.out.includes(host), 'the value must not be printed');
  }
});

test('RESET trap self-check: a permitted loopback target DOES attempt a connection (so 0 above is meaningful)', () => {
  const r = runScript(SCRIPT, { REDIS_URL: 'redis://127.0.0.1:9', E2E_REDIS_IDENTITY_TOKEN: RUN_TOKEN });
  assert.ok(r.attempts >= 1, `the trap must observe the attempt: ${r.out}`);
});

// Round 26 / C3: the production lists and the normalisation now live in THE shared rule
// (scripts/lib/e2eRedisIdentityRule.cjs), so these two controls mutate a copy of that module. The
// script and the mutated module are copied side by side (scripts/ + scripts/lib/) so the script's
// relative require loads the mutant.
const RULE = path.join(REPO, 'scripts', 'lib', 'e2eRedisIdentityRule.cjs');

function withMutantRule<T>(mutations: ReadonlyArray<readonly [string, string]>, fn: (script: string, rulePath: string) => T): T {
  let rule = fs.readFileSync(RULE, 'utf8');
  for (const [marker, replacement] of mutations) {
    assert.equal(rule.split(marker).length - 1, 1, `mutation marker must occur exactly once: ${marker}`);
    rule = rule.replace(marker, replacement);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-mutant-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    const script = path.join(dir, 'scripts', 'reset-auth-e2e-rate-limits.js');
    const rulePath = path.join(dir, 'scripts', 'lib', 'e2eRedisIdentityRule.cjs');
    fs.copyFileSync(SCRIPT, script);
    fs.writeFileSync(rulePath, rule);
    return fn(script, rulePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('RESET CONTROL with the live host removed from the shared rule, a production target reaches the network', () => {
  // C3 defence in depth: a production target must also pass positive identification to be used at all,
  // so the control approves the live host as itself; only the production-identity lists stop it.
  const env = { E2E_REDIS_URL: `rediss://default:${PW}@${LIVE}:6379`, E2E_REDIS_APPROVED_HOST: LIVE, E2E_REDIS_IDENTITY_TOKEN: 'c3-run-token-0123456789abcdef' };
  const real = runScript(SCRIPT, env);
  assert.equal(real.attempts, 0, `the real script must refuse before the network: ${real.out}`);
  assert.match(real.out, /production/);
  withMutantRule([
    ["const PRODUCTION_REDIS_HOSTS = Object.freeze(['right-treefrog-90757.upstash.io', 'noble-dane-77325.upstash.io']);", "const PRODUCTION_REDIS_HOSTS = Object.freeze(['noble-dane-77325.upstash.io']);"],
    ["const PRODUCTION_REDIS_IDENTITIES = Object.freeze(['right-treefrog-90757', 'noble-dane-77325']);", "const PRODUCTION_REDIS_IDENTITIES = Object.freeze(['noble-dane-77325']);"],
  ], (script) => {
    const r = runScript(script, env);
    assert.ok(r.attempts >= 1, `the control must observe a network attempt to the live production host: ${r.out}`);
  });
});

test('RESET CONTROL with the previous case-sensitive raw check, an upper-case production host is not recognised', () => {
  const upper = `rediss://default:${PW}@${LIVE.toUpperCase()}:6379`;
  refused({ REDIS_URL: upper }, 'upper-case live host (real rule)', /production/);
  withMutantRule([
    ['  const forms = denialCandidates(value);\n  return [', '  const forms = [String(value)];\n  return ['],
  ], (_script, rulePath) => {
    const real = createRequire(__filename)(RULE) as { namesProduction: (v: string) => boolean };
    const mutant = createRequire(__filename)(rulePath) as { namesProduction: (v: string) => boolean };
    assert.equal(real.namesProduction(upper), true);
    assert.equal(mutant.namesProduction(upper), false, 'the control must observe the upper-case host passing the identity check');
  });
});
