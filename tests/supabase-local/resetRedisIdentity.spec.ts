/**
 * Round 26 / C3 — the rate-limit reset script (the only E2E component that WRITES to Redis) is
 * FAIL-CLOSED: a hosted Redis is used only when positively identified, production is refused
 * regardless of hostname, and before ANY write the disposable Redis must carry the run's identity
 * marker (GET omnivyra:e2e:identity).
 *
 * Every case runs the REAL script as a child process:
 *   - the network is trapped (net.Socket#connect and dns.lookup throw and are counted), and
 *   - ioredis is replaced by a stub (the script loads <cwd>/node_modules/ioredis) that records every
 *     construction and command, so "no client", "GET only" and "SCAN/DEL happened" are observable.
 * Both the current script and the f237b92f0 script load ioredis this way, so the same spec is the
 * failing control when pointed at the f237b92f0 script (C3_RESET_SCRIPT=<path>); see
 * CT-ROUND26-C3-REDIS-GUARD.md.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = process.env.C3_RESET_SCRIPT || path.join(REPO, 'scripts', 'reset-auth-e2e-rate-limits.js');
const SEED = path.join(REPO, 'scripts', 'seed-auth-e2e-redis-identity.js');

const LIVE = 'right-treefrog-90757.upstash.io';
const STALE = 'noble-dane-77325.upstash.io';
const APPROVED = 'c3-disposable-e2e-0001.upstash.io';
const UNAPPROVED = 'brave-otter-12345.upstash.io';
const PW = 'fixture-redis-pw';
const TOKEN = 'c3-run-token-0123456789abcdef';
const APPROVED_URL = `rediss://default:${PW}@${APPROVED}:6379`;
const APPROVAL = { E2E_REDIS_URL: APPROVED_URL, E2E_REDIS_APPROVED_HOST: APPROVED, E2E_REDIS_IDENTITY_TOKEN: TOKEN };

const STUB = [
  "const fs = require('fs');",
  'const LOG = process.env.C3_STUB_LOG;',
  "const note = (s) => fs.appendFileSync(LOG, s + '\\n');",
  'class StubRedis {',
  "  constructor() { note('new'); }",
  "  async connect() { note('connect'); }",
  "  async get(key) { note('get ' + key); return process.env.C3_STUB_MARKER === undefined ? null : process.env.C3_STUB_MARKER; }",
  "  async scan(cursor, _m, pattern) { note('scan ' + pattern); return ['0', pattern === 'rl:login:*' ? ['rl:login:1.2.3.4'] : []]; }",
  "  async del(...keys) { note('del ' + keys.join(',')); return keys.length; }",
  "  async dbsize() { note('dbsize'); return Number(process.env.C3_STUB_DBSIZE || '0'); }",
  "  async set(key, _value, mode) { note('set ' + key + ' ' + mode); return 'OK'; }",
  "  disconnect() { note('disconnect'); }",
  '}',
  'module.exports = StubRedis;',
  '',
].join('\n');

type Run = { status: number | null; out: string; net: number; calls: string[] };

function run(env: Record<string, string>, marker?: string, script: string = SCRIPT, args: string[] = [], inspect?: (dir: string) => void): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-reset-'));
  try {
    const trapLog = path.join(dir, 'net.log');
    const stubLog = path.join(dir, 'stub.log');
    const trap = path.join(dir, 'trap.js');
    fs.writeFileSync(trapLog, '');
    fs.writeFileSync(stubLog, '');
    fs.mkdirSync(path.join(dir, 'node_modules', 'ioredis'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'ioredis', 'index.js'), STUB);
    fs.writeFileSync(trap, [
      "const fs = require('fs'); const net = require('net'); const dns = require('dns');",
      `const LOG = ${JSON.stringify(trapLog)};`,
      "net.Socket.prototype.connect = function () { fs.appendFileSync(LOG, 'connect\\n'); throw new Error('network trapped'); };",
      "dns.lookup = function () { fs.appendFileSync(LOG, 'lookup\\n'); throw new Error('network trapped'); };",
      '',
    ].join('\n'));
    const base: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      AUTH_E2E_ENV_FILE: path.join(dir, 'no-such-env-file'),
      C3_STUB_LOG: stubLog,
    };
    if (marker !== undefined) base.C3_STUB_MARKER = marker;
    // cwd = the temp dir: the script loads <cwd>/node_modules/ioredis (the stub) and no .env.e2e exists there.
    const r = spawnSync(process.execPath, ['--require', trap, script, ...args], { cwd: dir, env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 });
    if (inspect) inspect(dir);
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      net: fs.readFileSync(trapLog, 'utf8').split('\n').filter(Boolean).length,
      calls: fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function refusedBeforeAnyClient(env: Record<string, string>, why: string, rule: RegExp): void {
  const r = run(env, TOKEN);
  assert.equal(r.status, 1, `${why}: exit status\n${r.out}`);
  assert.deepEqual(r.calls, [], `${why}: no Redis client may be created\n${r.out}`);
  assert.equal(r.net, 0, `${why}: no network attempt`);
  assert.match(r.out, /REFUSING/, why);
  assert.match(r.out, rule, `${why}: must name the rule`);
  for (const s of [PW, TOKEN, LIVE, STALE, APPROVED, UNAPPROVED, 'right-treefrog', 'noble-dane']) assert.ok(!r.out.toLowerCase().includes(s.toLowerCase()), `${why}: output echoed a value`);
}

const PROD = /R-PROD-IDENTITY|R-APPROVED-IS-PROD/;

test('C3 RESET stub self-check: loopback reaches SCAN/DEL through the stub (so "no client" below is meaningful)', () => {
  const r = run({ REDIS_URL: 'redis://127.0.0.1:6379', E2E_REDIS_IDENTITY_TOKEN: TOKEN }, TOKEN);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.calls.includes('new') && r.calls.includes('scan rl:login:*') && r.calls.includes('del rl:login:1.2.3.4'), r.calls.join(' | '));
  assert.equal(r.net, 0);
});

test('C3 RESET unapproved hosted Redis is REFUSED before any client exists', () => {
  refusedBeforeAnyClient({ ...APPROVAL, E2E_REDIS_URL: `rediss://default:${PW}@${UNAPPROVED}:6379` }, 'unapproved host', /R-NOT-APPROVED/);
});

test('C3 RESET missing approval configuration is REFUSED (fail closed)', () => {
  refusedBeforeAnyClient({ E2E_REDIS_URL: APPROVED_URL }, 'no approval at all', /R-APPROVAL-MISSING/);
  refusedBeforeAnyClient({ E2E_REDIS_URL: APPROVED_URL, E2E_REDIS_IDENTITY_TOKEN: TOKEN }, 'no approved host', /R-APPROVAL-MISSING/);
  refusedBeforeAnyClient({ E2E_REDIS_URL: APPROVED_URL, E2E_REDIS_APPROVED_HOST: APPROVED }, 'no identity token', /R-APPROVAL-MISSING/);
});

test('C3 RESET approved == production is REFUSED', () => {
  refusedBeforeAnyClient({ ...APPROVAL, E2E_REDIS_APPROVED_HOST: LIVE }, 'approved = live prod host', PROD);
  refusedBeforeAnyClient({ ...APPROVAL, E2E_REDIS_URL: `rediss://default:${PW}@${LIVE}:6379`, E2E_REDIS_APPROVED_HOST: LIVE }, 'approved = target = live prod', PROD);
  refusedBeforeAnyClient({ ...APPROVAL, E2E_REDIS_APPROVED_HOST: 'right-treefrog-90757.cache.example.net' }, 'approved = prod identity under another domain', /R-APPROVED-IS-PROD/);
});

test('C3 RESET the production host in every URL form is REFUSED (both variables, also when approved as itself)', () => {
  for (const host of [LIVE, STALE]) {
    for (const [why, url] of [
      ['rediss + user-info', `rediss://default:${PW}@${host}:6379`],
      ['redis', `redis://${host}:6379`],
      ['port', `rediss://default:${PW}@${host}:6380`],
      ['upper case', `rediss://default:${PW}@${host.toUpperCase()}:6379`],
      ['trailing dot', `rediss://default:${PW}@${host}.:6379`],
      ['user-info smuggling', `rediss://${host}:${PW}@cache.example.net:6379`],
      ['percent-encoded', `rediss://default:${PW}@${host.replace('-', '%2D')}:6379`],
      ['https REST', `https://${host}`],
      ['identity, other domain', `rediss://default:${PW}@${host.split('.')[0]}.other-cache.example.net:6379`],
    ] as const) {
      refusedBeforeAnyClient({ ...APPROVAL, E2E_REDIS_URL: url, E2E_REDIS_APPROVED_HOST: host }, `${host} ${why} (E2E_REDIS_URL, approved as itself)`, PROD);
      refusedBeforeAnyClient({ REDIS_URL: url }, `${host} ${why} (REDIS_URL)`, PROD);
    }
  }
});

test('C3 RESET same host as a production-named variable (REDIS_URL / UPSTASH_REDIS_REST_URL) is REFUSED', () => {
  refusedBeforeAnyClient({ ...APPROVAL, REDIS_URL: APPROVED_URL }, 'REDIS_URL equal to the approved target', /R-SAME-HOST-AS-PROD-VAR/);
  refusedBeforeAnyClient({ ...APPROVAL, UPSTASH_REDIS_REST_URL: `https://${APPROVED}` }, 'UPSTASH_REDIS_REST_URL same host', /R-SAME-HOST-AS-PROD-VAR/);
  refusedBeforeAnyClient({ REDIS_URL: APPROVED_URL, E2E_REDIS_APPROVED_HOST: APPROVED, E2E_REDIS_IDENTITY_TOKEN: TOKEN }, 'hosted target through REDIS_URL', /R-NOT-APPROVED/); // review M1
});

test('C3 RESET marker ABSENT or MISMATCHING is REFUSED after a GET and before any SCAN/DEL', () => {
  for (const [why, marker] of [['absent', undefined], ['mismatch', 'c3-run-token-0123456789abcdeX']] as const) {
    const r = run(APPROVAL, marker);
    assert.equal(r.status, 1, `${why}\n${r.out}`);
    assert.deepEqual(r.calls, ['new', 'connect', 'get omnivyra:e2e:identity', 'disconnect'], `${why}: only the marker GET may be issued\n${r.out}`);
    assert.match(r.out, /R-MARKER/, why);
    assert.ok(!r.out.includes(TOKEN) && !r.out.includes(PW) && !r.out.includes(APPROVED), `${why}: output echoed a value`);
  }
});

test('C3 RESET marker MATCH on the approved disposable Redis is allowed (GET first, then the scoped reset)', () => {
  const r = run(APPROVAL, TOKEN);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls[2], 'get omnivyra:e2e:identity', r.calls.join(' | '));
  assert.ok(r.calls.indexOf('get omnivyra:e2e:identity') < r.calls.indexOf('scan rl:login:*'));
  assert.ok(r.calls.includes('del rl:login:1.2.3.4'));
  assert.equal(r.net, 0);
});

test('C3 RESET loopback with a token in force also verifies the marker before writing', () => {
  const r = run({ REDIS_URL: 'redis://127.0.0.1:6379', E2E_REDIS_IDENTITY_TOKEN: TOKEN });
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.calls, ['new', 'connect', 'get omnivyra:e2e:identity', 'disconnect']);
});

// ------------------------------------------------------------------ review C2: loopback is identified too
test('C3 C2 RESET loopback WITHOUT the run token is REFUSED before any client exists (a loopback port can be a tunnel to Production)', () => {
  for (const url of ['redis://127.0.0.1:6379', 'redis://localhost:16379', 'redis://[::1]:6379/0']) {
    refusedBeforeAnyClient({ REDIS_URL: url }, `loopback ${url} without a token`, /R-APPROVAL-MISSING/);
  }
});

test('C3 C2 RESET a loopback tunnel without the marker (e.g. Production behind a port-forward) is never wiped', () => {
  const r = run({ REDIS_URL: 'redis://127.0.0.1:16379', E2E_REDIS_IDENTITY_TOKEN: TOKEN }); // marker absent
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(r.calls, ['new', 'connect', 'get omnivyra:e2e:identity', 'disconnect'], r.out);
  assert.match(r.out, /R-MARKER/);
});

// ------------------------------------------------------------------ review C2: provisioning (seed) step
function seedRun(env: Record<string, string>, opts: { marker?: string; dbsize?: string; envOut?: boolean } = {}): Run & { envOut: string | null } {
  let envOut: string | null = null;
  const extra: Record<string, string> = { ...env };
  if (opts.dbsize !== undefined) extra.C3_STUB_DBSIZE = opts.dbsize;
  const args = opts.envOut ? ['--env-out', 'github-env.txt'] : [];
  const r = run(extra, opts.marker, SEED, args, (dir) => {
    const f = path.join(dir, 'github-env.txt');
    envOut = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  });
  return { ...r, envOut };
}

test('C3 C2 SEED a fresh, empty loopback Redis gets the marker with SET NX; a random per-run token goes to --env-out and is never printed', () => {
  const r = seedRun({ REDIS_URL: 'redis://127.0.0.1:6379', GITHUB_ACTIONS: 'true' }, { envOut: true });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls, ['new', 'connect', 'get omnivyra:e2e:identity', 'dbsize', 'set omnivyra:e2e:identity NX', 'disconnect']);
  const m = /^E2E_REDIS_IDENTITY_TOKEN=([0-9a-f]{48})\n$/.exec(r.envOut ?? '');
  assert.ok(m, `env-out must hold exactly the generated token line: ${JSON.stringify(r.envOut?.length)}`);
  const token = m![1];
  const lines = r.out.split('\n').filter((l) => l.includes(token));
  assert.deepEqual(lines, [`::add-mask::${token}`], 'the token may appear only in the add-mask command');
  assert.equal(r.net, 0);
});

test('C3 C2 SEED a NON-EMPTY Redis is never seeded (Production is never empty)', () => {
  const r = seedRun({ REDIS_URL: 'redis://127.0.0.1:16379', E2E_REDIS_IDENTITY_TOKEN: TOKEN }, { dbsize: '42' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /R-SEED-NOT-EMPTY/);
  assert.ok(!r.calls.some((c) => c.startsWith('set ')), r.calls.join(' | '));
});

test('C3 C2 SEED production in any form is refused before any client exists', () => {
  for (const url of [`rediss://default:${PW}@${LIVE}:6379`, `rediss://default:${PW}@right-treefrog-90757.evil.example:6379`]) {
    const r = seedRun({ REDIS_URL: url, E2E_REDIS_IDENTITY_TOKEN: TOKEN });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(r.calls, []);
    assert.match(r.out, /R-PROD-IDENTITY/);
  }
  const hosted = seedRun({ E2E_REDIS_URL: `rediss://default:${PW}@${UNAPPROVED}:6379`, E2E_REDIS_APPROVED_HOST: APPROVED, E2E_REDIS_IDENTITY_TOKEN: TOKEN });
  assert.equal(hosted.status, 1);
  assert.deepEqual(hosted.calls, []);
});

test('C3 C2 SEED a different existing marker is refused; the same token is an idempotent no-op; no token and no --env-out is refused', () => {
  const other = seedRun({ REDIS_URL: 'redis://127.0.0.1:6379', E2E_REDIS_IDENTITY_TOKEN: TOKEN }, { marker: 'another-run-token-0123456789ab' });
  assert.equal(other.status, 1, other.out);
  assert.ok(!other.calls.some((c) => c.startsWith('set ')));
  const same = seedRun({ REDIS_URL: 'redis://127.0.0.1:6379', E2E_REDIS_IDENTITY_TOKEN: TOKEN }, { marker: TOKEN, dbsize: '7' });
  assert.equal(same.status, 0, same.out);
  assert.ok(!same.calls.some((c) => c.startsWith('set ') || c === 'dbsize'));
  const none = seedRun({ REDIS_URL: 'redis://127.0.0.1:6379' });
  assert.equal(none.status, 1);
  assert.deepEqual(none.calls, []);
  assert.ok(!same.out.includes(TOKEN) && !other.out.includes(TOKEN));
});

test('C3 C2 SEED then RESET: the token written by the seed lets the reset pass its marker check (round trip)', () => {
  const s1 = seedRun({ REDIS_URL: 'redis://127.0.0.1:6379' }, { envOut: true });
  assert.equal(s1.status, 0, s1.out);
  const token = /E2E_REDIS_IDENTITY_TOKEN=([0-9a-f]{48})/.exec(s1.envOut ?? '')![1];
  const r = run({ REDIS_URL: 'redis://127.0.0.1:6379', E2E_REDIS_IDENTITY_TOKEN: token }, token);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.calls.includes('del rl:login:1.2.3.4'));
});
