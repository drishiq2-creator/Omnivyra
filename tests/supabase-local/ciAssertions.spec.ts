import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CiAssertionError,
  assertBootstrapResult,
  assertEnvLocal,
  assertSuiteResult,
  findHostedMarkers,
  parseSuiteLog,
} from './ciAssertions';
import { E2EEnvironmentError } from '../auth/e2eEnvironmentGuard';

const LOCAL = {
  AUTH_E2E_TARGET: 'local',
  E2E_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  E2E_SUPABASE_SECRET_KEY: 'local-secret-key-for-tests-only',
  SUPABASE_SECRET_KEY: 'local-secret-key-for-tests-only',
  AUTH_E2E_BASE_URL: 'http://localhost:3000',
  REDIS_URL: 'redis://127.0.0.1:6379',
  PATH: '/opt/hostedtoolcache/supabase/2.122.0/x64:/usr/bin',
};

test('CI env: a clean local environment passes', () => {
  assertEnvLocal(LOCAL);
});

test('CI env: hosted markers in ANY variable fail, without echoing the value', () => {
  for (const [k, v] of [
    ['SOME_UNRELATED_VAR', 'https://klkiseupptzbecbxwrky.supabase.co'],
    ['NEXT_PUBLIC_SITE_HINT', 'https://lomndxmrpyudaegddpef.supabase.co'],
    ['DATABASE_URL', 'postgresql://postgres:pw@db.example.supabase.co:5432/postgres'],
    ['X', 'https://abc.supabase.in'],
  ]) {
    assert.throws(
      () => assertEnvLocal({ ...LOCAL, [k]: v }),
      (e: unknown) => (e instanceof CiAssertionError || e instanceof E2EEnvironmentError) && !(e as Error).message.includes(v),
      `${k} must be refused`,
    );
  }
});

test('CI env: a non-local mode or an unset mode fails', () => {
  assert.throws(() => assertEnvLocal({ ...LOCAL, AUTH_E2E_TARGET: 'hosted' }), CiAssertionError);
  const { AUTH_E2E_TARGET: _drop, ...noMode } = LOCAL;
  assert.throws(() => assertEnvLocal(noMode), CiAssertionError);
});

const OK_BOOT = 'noise\nBOOTSTRAP_RESULT {"status":"ok","stage":"complete","schemaMode":"full","tables":"901","migrationsReplayed":104,"warnings":""}\n';

test('CI bootstrap: a complete full run with every migration passes', () => {
  assert.equal(assertBootstrapResult(OK_BOOT, 104, 823).migrationsReplayed, 104);
});

test('CI bootstrap: failure, partial replay, baseline-only, too few tables, warnings or a missing/duplicated line fail', () => {
  const bad = [
    OK_BOOT.replace('"status":"ok"', '"status":"failed"'),
    OK_BOOT.replace('"stage":"complete"', '"stage":"migration-replay"'),
    OK_BOOT.replace('"migrationsReplayed":104', '"migrationsReplayed":57'),
    OK_BOOT.replace('"schemaMode":"full"', '"schemaMode":"baseline-only"'),
    OK_BOOT.replace('"tables":"901"', '"tables":"12"'),
    OK_BOOT.replace('"warnings":""', '"warnings":"migrations NOT replayed"'),
    'no result line at all',
    OK_BOOT + OK_BOOT,
  ];
  for (const log of bad) assert.throws(() => assertBootstrapResult(log, 104, 823), CiAssertionError);
});

function specBlock(tests: number, pass: number, extra: Partial<Record<'fail' | 'skipped' | 'todo' | 'cancelled', number>> = {}): string {
  return [`# tests ${tests}`, `# suites 0`, `# pass ${pass}`, `# fail ${extra.fail ?? 0}`, `# cancelled ${extra.cancelled ?? 0}`, `# skipped ${extra.skipped ?? 0}`, `# todo ${extra.todo ?? 0}`].join('\n');
}
const GOOD_SUITE = [1, 2, 3, 4, 5].map(() => specBlock(1, 1)).join('\n') + '\n===== AUTH INTEGRITY SUMMARY =====\n5/5 specs passed, 0 failed\n';

test('CI suite: exactly 5 specs, 5 tests, 5 passed is accepted', () => {
  const r = assertSuiteResult(GOOD_SUITE, 5, 5);
  assert.deepEqual([r.specs, r.tests, r.pass, r.fail, r.skipped], [5, 5, 5, 0, 0]);
});

test('CI suite: a skipped, todo, failed, cancelled, missing or extra test is rejected', () => {
  const variants = [
    [1, 2, 3, 4].map(() => specBlock(1, 1)).join('\n') + '\n' + specBlock(1, 0, { skipped: 1 }) + '\n5/5 specs passed, 0 failed\n',
    [1, 2, 3, 4].map(() => specBlock(1, 1)).join('\n') + '\n' + specBlock(1, 0, { todo: 1 }) + '\n5/5 specs passed, 0 failed\n',
    [1, 2, 3, 4].map(() => specBlock(1, 1)).join('\n') + '\n' + specBlock(1, 0, { fail: 1 }) + '\n4/5 specs passed, 1 failed\n',
    [1, 2, 3, 4].map(() => specBlock(1, 1)).join('\n') + '\n' + specBlock(1, 0, { cancelled: 1 }) + '\n5/5 specs passed, 0 failed\n',
    [1, 2, 3, 4].map(() => specBlock(1, 1)).join('\n') + '\n4/4 specs passed, 0 failed\n',
    [1, 2, 3, 4, 5, 6].map(() => specBlock(1, 1)).join('\n') + '\n6/6 specs passed, 0 failed\n',
    [1, 2, 3, 4].map(() => specBlock(1, 1)).join('\n') + '\n' + specBlock(0, 0) + '\n5/5 specs passed, 0 failed\n',
    GOOD_SUITE.replace('5/5 specs passed, 0 failed', ''),
  ];
  for (const log of variants) assert.throws(() => assertSuiteResult(log, 5, 5), CiAssertionError, `must reject:\n${log}`);
});

test('CI suite: the parser reads the TAP summary lines', () => {
  assert.deepEqual(parseSuiteLog(GOOD_SUITE).tests, 5);
});

test('CI log scan: hosted markers are found; a clean local log is clean', () => {
  assert.deepEqual(findHostedMarkers('GET http://127.0.0.1:54321/auth/v1/user 200'), []);
  assert.ok(findHostedMarkers('fetch https://klkiseupptzbecbxwrky.supabase.co/rest').length > 0);
  assert.ok(findHostedMarkers('connecting to aws-1-x.pooler.supabase.com').length > 0);
});

// ---------------- v3 (review findings F4, F17) ----------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REDACTED_VALUE_VARIABLES, redactSecrets } from './ciAssertions';

test('CI v3 F4 hosted Redis markers (the production Upstash host, any *.upstash.io) are found', () => {
  assert.ok(findHostedMarkers('connecting to noble-dane-77325.upstash.io:6379').length > 0);
  assert.ok(findHostedMarkers('rediss://default:x@other-host-1.upstash.io:6379').length > 0);
  assert.throws(() => assertEnvLocal({ ...LOCAL, SOME_CACHE_HINT: 'https://x.upstash.io' }), (e: unknown) => e instanceof CiAssertionError || e instanceof E2EEnvironmentError);
});

const SECRET_A = 'local-secret-key-value-AAAAAAAA';
const SECRET_B = 'per-run-session-secret-BBBBBBBB';
const LEAKY_LOG = [
  `apikey=${SECRET_A} and again ${SECRET_A}`,
  `cookie secret ${SECRET_B}`,
  'redis connect redis://someuser:redis-password@127.0.0.1:6379/0',
  'db postgresql://postgres:db-password@127.0.0.1:54322/postgres',
  'plain http://127.0.0.1:54321/auth/v1/health 200',
].join('\n');

test('CI v3 F17 redactSecrets removes every secret value and every URL user-info, and counts them', () => {
  const r = redactSecrets(LEAKY_LOG, [SECRET_A, SECRET_B, 'short']);
  for (const s of [SECRET_A, SECRET_B, 'redis-password', 'db-password', 'someuser:']) assert.ok(!r.text.includes(s), `left ${s}`);
  assert.equal(r.replaced, 5);
  assert.match(r.text, /redis:\/\/\[REDACTED\]@127\.0\.0\.1:6379\/0/);
  assert.match(r.text, /http:\/\/127\.0\.0\.1:54321\/auth\/v1\/health 200/, 'non-secret content is kept');
  assert.equal(redactSecrets('nothing here', ['ab']).replaced, 0, 'values shorter than 8 characters are never used as patterns');
  assert.deepEqual([...REDACTED_VALUE_VARIABLES].sort(), ['E2E_SUPABASE_SECRET_KEY', 'ENCRYPTION_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SESSION_COOKIE_SECRET', 'SUPABASE_SECRET_KEY']);
});

test('CI v3 F17 CONTROL without the user-info rule, URL passwords survive redaction', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'ciAssertions.ts'), 'utf8');
  const marker = '  out = out.replace(URL_USERINFO, (_m, scheme: string) => {';
  assert.equal(source.split(marker).length - 1, 1);
  const dir = fs.mkdtempSync(path.join(__dirname, '.mutant-ci-'));
  const file = path.join(dir, 'ciAssertions.ts');
  fs.writeFileSync(file, source.replace(marker, '  out = out.replace(/(?!)/g, (_m, scheme: string) => {').replace("from '../auth/e2eEnvironmentGuard'", `from ${JSON.stringify(pathToFileURL(path.join(__dirname, '..', 'auth', 'e2eEnvironmentGuard.ts')).href)}`));
  try {
    const mutant = await import(pathToFileURL(file).href);
    const r = mutant.redactSecrets(LEAKY_LOG, [SECRET_A, SECRET_B]);
    assert.ok(r.text.includes('redis-password'), 'the control must observe the surviving password');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- v3.1 (independent delta review R1, R5) ----------------
import { spawnSync } from 'node:child_process';
import { maskedValues } from './ciAssertions';

const TSX = path.join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MASKED_KEY = 'masked-local-stack-key-CCCCCCCC';
const MASKED_DB = 'postgresql://postgres:masked-db-pw@127.0.0.1:54322/postgres';
const TEED_LOG = [
  `::add-mask::${MASKED_DB}`,
  `::add-mask::${MASKED_KEY}`,
  'FAIL [migration-replay]: migration 2027_x.sql did not apply',
  `debug echo of ${MASKED_KEY} later in the log`,
].join('\n');

function runRedactCli(script: string, files: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const r = spawnSync(process.execPath, [TSX, script, 'redact-logs', ...files], { env, encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('CI v3.1 R1 values masked via ::add-mask:: are redacted from the log itself, with NO secret variables in the step env', () => {
  assert.deepEqual(maskedValues(TEED_LOG), [MASKED_DB, MASKED_KEY]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-r1-'));
  try {
    const file = path.join(dir, 'bootstrap-up.log');
    fs.writeFileSync(file, TEED_LOG);
    const r = runRedactCli(path.join(__dirname, 'ciAssertions.ts'), [file]);
    assert.equal(r.status, 0, r.out);
    const after = fs.readFileSync(file, 'utf8');
    for (const s of [MASKED_KEY, 'masked-db-pw']) assert.ok(!after.includes(s), `left ${s}`);
    assert.ok(!r.out.includes(MASKED_KEY), 'the CLI never prints a value');
    assert.match(after, /did not apply/, 'diagnostics are kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI v3.1 CONTROL R1 without collecting masked values, a job-1 style log keeps the key', () => {
  const source = fs.readFileSync(path.join(__dirname, 'ciAssertions.ts'), 'utf8');
  const marker = '        ...present.flatMap((file) => maskedValues(fs.readFileSync(file, \'utf8\'))),\n';
  assert.equal(source.split(marker).length - 1, 1);
  const dir = fs.mkdtempSync(path.join(__dirname, '.mutant-ci-r1-'));
  try {
    const mutant = path.join(dir, 'ciAssertions.ts');
    fs.writeFileSync(mutant, source.replace(marker, '').replace("from '../auth/e2eEnvironmentGuard'", `from ${JSON.stringify(path.join(__dirname, '..', 'auth', 'e2eEnvironmentGuard.ts').split(path.sep).join('/'))}`));
    const file = path.join(dir, 'bootstrap-up.log');
    fs.writeFileSync(file, TEED_LOG);
    const r = runRedactCli(mutant, [file]);
    assert.equal(r.status, 0, r.out);
    assert.ok(fs.readFileSync(file, 'utf8').includes(MASKED_KEY), 'the control must observe the surviving key');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI v3.1 R5 passwords containing "@" or "/" and encoded secret forms are fully redacted', () => {
  const secret = 'secret/with+chars=AAAA';
  const r = redactSecrets([
    'redis://:p@ss@127.0.0.1:6379',
    'postgres://user:fake/pw@h/db',
    `encoded ${encodeURIComponent(secret)} and json ${JSON.stringify({ k: 'x"' + secret }).slice(0, 0)}${JSON.stringify(secret).slice(1, -1)}`,
  ].join('\n'), [secret]);
  for (const s of ['ss@127', 'p@ss', 'fake/pw', encodeURIComponent(secret), secret]) assert.ok(!r.text.includes(s), `left ${s}`);
  assert.match(r.text, /redis:\/\/\[REDACTED\]@127\.0\.0\.1:6379/);
});

test('CI v3.1 CONTROL R5 the previous user-info pattern left part of an "@" password', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'ciAssertions.ts'), 'utf8');
  const marker = String.raw`const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s'"<>]*@/gi;`;
  assert.equal(source.split(marker).length - 1, 1);
  const dir = fs.mkdtempSync(path.join(__dirname, '.mutant-ci-r5-'));
  const file = path.join(dir, 'ciAssertions.ts');
  fs.writeFileSync(file, source.replace(marker, String.raw`const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]*:[^\s/@'"<>]*@/gi;`).replace("from '../auth/e2eEnvironmentGuard'", `from ${JSON.stringify(pathToFileURL(path.join(__dirname, '..', 'auth', 'e2eEnvironmentGuard.ts')).href)}`));
  try {
    const mutant = await import(pathToFileURL(file).href);
    assert.ok(mutant.redactSecrets('redis://:p@ss@127.0.0.1:6379', []).text.includes('ss@127'), 'the control must observe the partial leak');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
