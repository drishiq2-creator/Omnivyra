/**
 * Review finding F17: connection URLs that reach the app server log (uploaded as a CI artifact)
 * must never carry a user name with password, a password, a query string or a fragment, and an
 * unparseable value must never be echoed. Behavioural tests on the real modules, each with a
 * failing control (a scratch copy with the redaction removed must leak).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(__dirname, '..', '..');
const SECRET_PW = 'redis-pw-must-not-leak';
const SECRET_QUERY = 'query-secret-must-not-leak';
const LEAKY_REDIS_URL = `redis://someuser:${SECRET_PW}@localhost:6379/0?password=${SECRET_QUERY}#frag-${SECRET_QUERY}`;

async function importCopy(relative: string, mutations: ReadonlyArray<readonly [string, string]> = []): Promise<{ mod: Record<string, unknown>; done: () => void }> {
  let source = fs.readFileSync(path.join(REPO, relative), 'utf8');
  for (const [marker, replacement] of mutations) {
    assert.equal(source.split(marker).length - 1, 1, `mutation marker must occur exactly once: ${marker}`);
    source = source.replace(marker, replacement);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-redaction-'));
  const file = path.join(dir, path.basename(relative));
  fs.writeFileSync(file, source);
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  return { mod, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function fatalMessage(mutations: ReadonlyArray<readonly [string, string]> = []): Promise<string> {
  const { mod, done } = await importCopy('lib/env/namespace.ts', mutations);
  const saved = { ...process.env };
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    delete process.env.ALLOW_PROD_DB_WITH_LOCAL_REDIS;
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.REDIS_URL = LEAKY_REDIS_URL;
    assert.throws(() => (mod.enforceEnvIsolationFatal as () => void)(), /topology blocked/);
  } finally {
    console.error = original;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    done();
  }
  return errors.join('\n');
}

test('F17 the prod-Supabase/local-Redis fatal message shows only scheme, host and port of REDIS_URL', async () => {
  const msg = await fatalMessage();
  assert.match(msg, /REDIS_URL: +redis:\/\/localhost:6379\n/);
  for (const secret of [SECRET_PW, SECRET_QUERY, 'someuser', 'frag-']) assert.ok(!msg.includes(secret), `leaked ${secret}`);
});

test('F17 CONTROL the fatal message DOES leak when the redaction is removed', async () => {
  const msg = await fatalMessage([['`  REDIS_URL:         ${redisShown}\\n\\n` +', '`  REDIS_URL:         ${redisUrl}\\n\\n` +']]);
  assert.ok(msg.includes(SECRET_PW), 'the control must observe the leak');
});

test('F17 maskRedisUrl hides the password, the query and the fragment, and never echoes an unparseable value', async () => {
  const { mod, done } = await importCopy('lib/redis/sanitizer.ts');
  try {
    const mask = mod.maskRedisUrl as (u: string) => string;
    const masked = mask(LEAKY_REDIS_URL);
    assert.equal(masked, 'redis://someuser:***@localhost:6379/0');
    const unparseable = mask(`not a url ${SECRET_PW}`);
    assert.ok(!unparseable.includes(SECRET_PW) && !unparseable.includes('not a url'), unparseable);
  } finally {
    done();
  }
});

test('F17 CONTROL maskRedisUrl leaks the query and a truncated raw value without the corrections', async () => {
  const { mod, done } = await importCopy('lib/redis/sanitizer.ts', [
    ["    parsed.search = '';\n    parsed.hash = '';\n", ''],
    ["    return '<unparseable Redis URL; value redacted>';", '    return url.substring(0, 30);'],
  ]);
  try {
    const mask = mod.maskRedisUrl as (u: string) => string;
    assert.ok(mask(LEAKY_REDIS_URL).includes(SECRET_QUERY), 'the control must observe the query leak');
    assert.ok(mask(`not a url ${SECRET_PW}`).includes('not a url'), 'the control must observe the raw echo');
  } finally {
    done();
  }
});

test('F17 the Redis client parse-failure log carries no part of the raw URL', () => {
  // lib/redis/client.ts pulls in the app config at import time, so this one is a source check of the
  // single log statement (the behavioural checks above cover the shared sanitiser and the fatal path).
  const source = fs.readFileSync(path.join(REPO, 'lib/redis/client.ts'), 'utf8');
  const block = /console\.error\('\[redis\.client\] Failed to parse REDIS_URL', \{([\s\S]*?)\}\);/.exec(source);
  assert.ok(block, 'the parse-failure log statement must exist');
  assert.match(block![1], /url: '<redacted>'/);
  assert.doesNotMatch(block![1], /url\.|substring|slice/);
});

test('F17/R6 lib/config/verification.ts never echoes an unparseable REDIS_URL', () => {
  // lib/config/verification.ts pulls in the app config at import time: source check of the one message.
  const source = fs.readFileSync(path.join(REPO, 'lib/config/verification.ts'), 'utf8');
  const block = /code: 'REDIS_URL_INVALID',([\s\S]*?)remediation:/.exec(source);
  assert.ok(block, 'the REDIS_URL_INVALID issue must exist');
  assert.doesNotMatch(block![1], /\$\{/, 'the message must not interpolate any value');
});
