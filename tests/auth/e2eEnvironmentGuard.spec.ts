import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_EXPECTED_E2E_PROJECT_REF,
  E2EEnvironmentError,
  assertNonProductionE2EEnvironment,
  extractProjectRef,
} from './e2eEnvironmentGuard';

const PRODUCTION_URL = 'https://klkiseupptzbecbxwrky.supabase.co';
const E2E_URL = 'https://' + DEFAULT_EXPECTED_E2E_PROJECT_REF + '.supabase.co';
const VALID_KEY = 'sb-service-role-key-for-tests-only-not-a-real-credential';

function expectRejected(
  input: Parameters<typeof assertNonProductionE2EEnvironment>[0],
  why: string,
): void {
  assert.throws(
    () => assertNonProductionE2EEnvironment(input),
    (error: unknown) => error instanceof E2EEnvironmentError,
    `guard must reject ${why}`,
  );
}

// ------------------------------------------------------------ Case 1: production
test('guard REJECTS the production Supabase URL', () => {
  expectRejected({ supabaseUrl: PRODUCTION_URL, serviceRoleKey: VALID_KEY }, 'the production URL');
});

test('guard REJECTS production even when the expected-project allowlist is disabled', () => {
  // Targets the production denylist SPECIFICALLY. Without this test, deleting the
  // denylist would be masked by the allowlist check.
  expectRejected(
    { supabaseUrl: PRODUCTION_URL, serviceRoleKey: VALID_KEY, expectedProjectRef: null },
    'the production URL with the allowlist disabled',
  );
});

test('guard REJECTS production when it is also named as the expected project', () => {
  expectRejected(
    {
      supabaseUrl: PRODUCTION_URL,
      serviceRoleKey: VALID_KEY,
      expectedProjectRef: 'klkiseupptzbecbxwrky',
    },
    'production even if misconfigured as the expected project',
  );
});

test('guard REJECTS the production project ref smuggled into another host', () => {
  expectRejected(
    {
      supabaseUrl: 'https://klkiseupptzbecbxwrky.pooler.supabase.co',
      serviceRoleKey: VALID_KEY,
      expectedProjectRef: null,
    },
    'a host containing the production ref',
  );
});

// ------------------------------------------------------------ Case 2: empty
test('guard REJECTS an empty Supabase URL', () => {
  expectRejected({ supabaseUrl: '', serviceRoleKey: VALID_KEY }, 'an empty URL');
});

test('guard REJECTS an undefined Supabase URL', () => {
  expectRejected({ supabaseUrl: undefined, serviceRoleKey: VALID_KEY }, 'an undefined URL');
});

test('guard REJECTS a whitespace-only Supabase URL', () => {
  expectRejected({ supabaseUrl: '   ', serviceRoleKey: VALID_KEY }, 'a whitespace URL');
});

// ------------------------------------------------------------ Case 3: valid E2E
test('guard ACCEPTS the dedicated E2E project', () => {
  const result = assertNonProductionE2EEnvironment({
    supabaseUrl: E2E_URL,
    serviceRoleKey: VALID_KEY,
  });
  assert.equal(result.projectRef, DEFAULT_EXPECTED_E2E_PROJECT_REF);
  assert.equal(result.hostname, DEFAULT_EXPECTED_E2E_PROJECT_REF + '.supabase.co');
});

test('guard result never contains the service-role key', () => {
  const result = assertNonProductionE2EEnvironment({
    supabaseUrl: E2E_URL,
    serviceRoleKey: VALID_KEY,
  });
  assert.ok(
    !JSON.stringify(result).includes(VALID_KEY),
    'guard result leaked the service-role key',
  );
});

// ------------------------------------------------------------ Case 4: malformed
test('guard REJECTS a malformed Supabase URL', () => {
  expectRejected({ supabaseUrl: 'not a url', serviceRoleKey: VALID_KEY }, 'a malformed URL');
});

test('guard REJECTS a URL with an unsupported protocol', () => {
  expectRejected(
    { supabaseUrl: 'ftp://lomndxmrpyudaegddpef.supabase.co', serviceRoleKey: VALID_KEY },
    'a non-http(s) URL',
  );
});

// ------------------------------------------------------- placeholder / local hosts
test('guard REJECTS the CI placeholder host', () => {
  expectRejected(
    { supabaseUrl: 'https://placeholder.supabase.co', serviceRoleKey: VALID_KEY, expectedProjectRef: null },
    'the CI placeholder',
  );
});

test('guard REJECTS a local Supabase instance', () => {
  expectRejected(
    { supabaseUrl: 'http://127.0.0.1:54321', serviceRoleKey: VALID_KEY, expectedProjectRef: null },
    'a local instance',
  );
  expectRejected(
    { supabaseUrl: 'http://localhost:54321', serviceRoleKey: VALID_KEY, expectedProjectRef: null },
    'localhost',
  );
});

test('guard REJECTS a non-Supabase host', () => {
  expectRejected(
    { supabaseUrl: 'https://evil.example.net', serviceRoleKey: VALID_KEY, expectedProjectRef: null },
    'a non-Supabase host',
  );
});

test('guard REJECTS an unexpected Supabase project', () => {
  expectRejected(
    { supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', serviceRoleKey: VALID_KEY },
    'a project that is not the expected E2E project',
  );
});

// ------------------------------------------------------------ credentials
test('guard REJECTS a missing service-role key', () => {
  expectRejected({ supabaseUrl: E2E_URL, serviceRoleKey: '' }, 'a missing service-role key');
});

test('guard REJECTS a placeholder service-role key', () => {
  expectRejected(
    { supabaseUrl: E2E_URL, serviceRoleKey: 'ci-hermetic-placeholder-service-role-key' },
    'a placeholder key',
  );
});

test('extractProjectRef derives refs only from well-formed Supabase hosts', () => {
  assert.equal(extractProjectRef(E2E_URL), DEFAULT_EXPECTED_E2E_PROJECT_REF);
  assert.equal(extractProjectRef('https://short.supabase.co'), null);
  assert.equal(extractProjectRef('nonsense'), null);
});

// ------------------------------------------------------------ MUTATION TEST
// Required by PHASE 147 / step 3: disabling the production rejection MUST be caught.
test('MUTATION: removing the production rejection is caught by the guard tests', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'e2eEnvironmentGuard.ts'), 'utf8');
  const marker = 'if (isProductionTarget(projectRef, hostname)) {';
  assert.ok(
    source.includes(marker),
    'production rejection block not found — update this mutation test',
  );

  // Mutate: neutralise the production rejection.
  const mutated = source.replace(marker, 'if (false && isProductionTarget(projectRef, hostname)) {');
  assert.notEqual(mutated, source, 'mutation was not applied');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e2e-mutant-'));
  const mutantPath = path.join(dir, 'mutantGuard.ts');
  fs.writeFileSync(mutantPath, mutated);

  try {
    const mutant = await import(pathToFileURL(mutantPath).href);

    // With the denylist neutralised the mutant must now ACCEPT production while the
    // allowlist is disabled. That is precisely the condition asserted by the
    // 'guard REJECTS production even when the expected-project allowlist is disabled'
    // test above, which therefore FAILS against the mutant => the mutation is caught.
    let mutantAcceptedProduction = false;
    try {
      mutant.assertNonProductionE2EEnvironment({
        supabaseUrl: PRODUCTION_URL,
        serviceRoleKey: VALID_KEY,
        expectedProjectRef: null,
      });
      mutantAcceptedProduction = true;
    } catch {
      mutantAcceptedProduction = false;
    }

    assert.equal(
      mutantAcceptedProduction,
      true,
      'mutant did not accept production, so no test detects removal of the production denylist — strengthen the guard tests',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// C2 — AUTH_E2E_TARGET modes and the single authoritative resolver.
// Every test below exercises the real implementation in e2eEnvironmentGuard.ts.
// No test performs a network request: reachability uses an injected fetch spy.
// =============================================================================

import { spawnSync } from 'node:child_process';
import {
  LOCAL_STACK_PORTS,
  assertLocalStackReachable,
  isResolvedAuthE2ETarget,
  loadE2EEnvFile,
  readAuthE2ETargetMode,
  resolveAuthE2ETarget,
  type ResolvedAuthE2ETarget,
} from './e2eEnvironmentGuard';

const LOCAL_API = 'http://127.0.0.1:54321';
const LOCAL_KEY = 'local-stack-service-key-for-tests-only-not-a-real-credential';
const LOCAL_DB_PASSWORD = 'local-db-password-for-tests-only';
const PROD_REF = 'klkiseupptzbecbxwrky';
const E2E_REF = DEFAULT_EXPECTED_E2E_PROJECT_REF;

type Env = Record<string, string | undefined>;

function localEnv(overrides: Env = {}): Env {
  const env: Env = {
    AUTH_E2E_TARGET: 'local',
    E2E_SUPABASE_URL: LOCAL_API,
    SUPABASE_URL: LOCAL_API,
    NEXT_PUBLIC_SUPABASE_URL: LOCAL_API,
    E2E_SUPABASE_SECRET_KEY: LOCAL_KEY,
    SUPABASE_SECRET_KEY: LOCAL_KEY,
    AUTH_E2E_BASE_URL: 'http://localhost:3000',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** Sets all three app-facing Supabase URL variables to the same value (local mode requires all three). */
function allUrls(url: string | undefined): Env {
  return { E2E_SUPABASE_URL: url, SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_URL: url };
}

function hostedEnv(overrides: Env = {}): Env {
  const env: Env = {
    E2E_SUPABASE_URL: E2E_URL,
    SUPABASE_URL: E2E_URL,
    NEXT_PUBLIC_SUPABASE_URL: E2E_URL,
    E2E_SUPABASE_SECRET_KEY: VALID_KEY,
    AUTH_E2E_BASE_URL: 'http://localhost:3000',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** Asserts rejection with an E2EEnvironmentError whose message leaks no secret. */
function expectTargetRejected(env: Env, why: string, mustMention?: RegExp): void {
  assert.throws(
    () => resolveAuthE2ETarget(env),
    (error: unknown) => {
      if (!(error instanceof E2EEnvironmentError)) return false;
      for (const secret of [LOCAL_KEY, VALID_KEY, LOCAL_DB_PASSWORD]) {
        assert.ok(!error.message.includes(secret), `error message leaked a secret while rejecting ${why}`);
      }
      if (mustMention) assert.match(error.message, mustMention, `error for ${why} must name the failing input`);
      return true;
    },
    `resolver must reject ${why}`,
  );
}

// ------------------------------------------------------------ Positive cases
test('C2 local: ACCEPTS the configured loopback stack (127.0.0.1)', () => {
  const t = resolveAuthE2ETarget(localEnv());
  assert.equal(t.mode, 'local');
  assert.equal(t.supabaseUrl, LOCAL_API);
  assert.equal(t.guard.projectRef, 'local');
  assert.ok(isResolvedAuthE2ETarget(t));
  assert.ok(!t.guard.description.includes(LOCAL_KEY));
});

test('C2 local: ACCEPTS localhost and [::1] when every variable agrees', () => {
  for (const host of ['localhost', '[::1]']) {
    const url = `http://${host}:54321`;
    const t = resolveAuthE2ETarget(localEnv({ E2E_SUPABASE_URL: url, SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_URL: url }));
    assert.equal(t.supabaseUrl, url);
  }
});

test('C2 local: ACCEPTS a loopback database URL with local-stack credentials (never echoed)', () => {
  const t = resolveAuthE2ETarget(localEnv({ SUPABASE_DB_URL: `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres` }));
  assert.equal(t.mode, 'local');
});

test('C2 hosted: default (AUTH_E2E_TARGET unset) is still the hosted E2E project, unchanged', () => {
  assert.equal(readAuthE2ETargetMode({}), 'hosted');
  const t = resolveAuthE2ETarget(hostedEnv());
  assert.equal(t.mode, 'hosted');
  assert.equal(t.guard.projectRef, E2E_REF);
  assert.equal(t.supabaseUrl, E2E_URL);
  const explicit = resolveAuthE2ETarget(hostedEnv({ AUTH_E2E_TARGET: 'hosted' }));
  assert.equal(explicit.mode, 'hosted');
});

test('C2 hosted: historical variable precedence is preserved (E2E_SUPABASE_URL first, secret key first)', () => {
  const t = resolveAuthE2ETarget(hostedEnv({ SUPABASE_SERVICE_ROLE_KEY: 'legacy-key-value-for-tests-only-0001' }));
  assert.equal(t.supabaseUrlVariable, 'E2E_SUPABASE_URL');
  assert.equal(t.serviceRoleKey, VALID_KEY);
});

// ------------------------------------------------------------ Negative cases (brief section 7.2)
test('C2 #1/#2 production project ref and hosted URL are rejected in local AND hosted mode', () => {
  expectTargetRejected(localEnv({ E2E_SUPABASE_URL: PRODUCTION_URL }), 'production URL in local mode', /PRODUCTION/);
  expectTargetRejected(hostedEnv({ E2E_SUPABASE_URL: PRODUCTION_URL }), 'production URL in hosted mode');
  expectTargetRejected(localEnv({ SUPABASE_URL: `http://127.0.0.1:54321/?ref=${PROD_REF}` }), 'production ref in a query string', /PRODUCTION/);
});

test('C2 #3/#4 legacy hosted E2E ref and URL are rejected in local mode', () => {
  expectTargetRejected(localEnv({ E2E_SUPABASE_URL: E2E_URL }), 'the hosted E2E URL in local mode', /legacy hosted E2E/);
  expectTargetRejected(
    localEnv({ SUPABASE_DB_URL: `postgresql://postgres.${E2E_REF}:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres` }),
    'the E2E ref smuggled into a loopback DB URL user name',
    /legacy hosted E2E/,
  );
});

test('C2 #5/#6/#7/#8 public, private-LAN, arbitrary and attacker hosts are rejected in local mode', () => {
  for (const url of [
    'http://8.8.8.8:54321',
    'http://192.168.1.10:54321',
    'http://10.0.0.5:54321',
    'http://172.16.0.9:54321',
    'http://example.org:54321',
    'http://api.attacker.example:54321',
  ]) {
    expectTargetRejected(localEnv({ ...allUrls(url) }), url, /E2E_SUPABASE_URL/);
  }
});

test('C2 #9/#10 loopback look-alike hostnames are rejected', () => {
  for (const url of [
    'http://localhost.attacker.example:54321',
    'https://127.0.0.1.attacker.example:54321',
    'http://127.0.0.1.attacker.example:54321',
    'http://127.0.0.1.evil:54321',
    'http://localhost.:54321',
  ]) {
    expectTargetRejected(localEnv({ ...allUrls(url) }), url);
  }
});

test('C2 #11 malformed URLs are rejected', () => {
  for (const url of ['not a url', 'http://', 'http://:54321', 'http://127.0.0.1:99999', '127.0.0.1:54321']) {
    expectTargetRejected(localEnv({ ...allUrls(url) }), `malformed ${url}`);
  }
});

test('C2 #12/#13 unexpected schemes and ports are rejected', () => {
  for (const url of ['https://127.0.0.1:54321', 'ftp://127.0.0.1:54321', 'ws://127.0.0.1:54321', 'http://127.0.0.1:5432', 'http://127.0.0.1:54322', 'http://127.0.0.1']) {
    expectTargetRejected(localEnv({ ...allUrls(url) }), url);
  }
});

test('C2 #14 embedded user-info credentials are rejected on API, app and Redis URLs', () => {
  expectTargetRejected(localEnv({ ...allUrls('http://user:pw@127.0.0.1:54321') }), 'user-info on the API URL', /credentials|@/);
  expectTargetRejected(localEnv({ AUTH_E2E_BASE_URL: 'http://user:pw@localhost:3000' }), 'user-info on the base URL', /AUTH_E2E_BASE_URL/);
  expectTargetRejected(localEnv({ REDIS_URL: 'redis://user:pw@127.0.0.1:6379' }), 'user-info on the Redis URL', /REDIS_URL/);
});

test('C2 #15/#16 missing or empty Supabase URL values are rejected (empty is never a target)', () => {
  expectTargetRejected(localEnv({ ...allUrls(undefined) }), 'no URL at all', /missing/);
  expectTargetRejected(localEnv({ E2E_SUPABASE_URL: '', SUPABASE_URL: '   ', NEXT_PUBLIC_SUPABASE_URL: '' }), 'only empty URL values', /missing|blank/);
  expectTargetRejected(hostedEnv({ E2E_SUPABASE_URL: '', SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_URL: '' }), 'only empty URL values in hosted mode', /missing/);
});

test('C2 #17/#18 unknown or empty AUTH_E2E_TARGET values are rejected; an unset mode never selects local', () => {
  for (const mode of ['staging', 'LOCAL', ' local', 'production', 'remote']) {
    expectTargetRejected(localEnv({ AUTH_E2E_TARGET: mode }), `mode "${mode}"`, /AUTH_E2E_TARGET/);
  }
  expectTargetRejected(localEnv({ AUTH_E2E_TARGET: '' }), 'an empty mode', /AUTH_E2E_TARGET/);
  // Mode unset + loopback URLs: hosted mode applies and refuses the local stack (fail closed, no silent switch).
  expectTargetRejected(localEnv({ AUTH_E2E_TARGET: undefined }), 'loopback URLs without an explicit local mode');
});

test('C2 #19 conflicting Supabase URL variables are rejected in local mode', () => {
  expectTargetRejected(localEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }), 'a different loopback spelling', /conflicts/);
  expectTargetRejected(localEnv({ SUPABASE_URL: 'http://127.0.0.1:54325' }), 'a different port on a secondary variable');
});

test('C2 #20 production supplied through a SECONDARY variable is rejected in both modes', () => {
  expectTargetRejected(hostedEnv({ NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL }), 'production in NEXT_PUBLIC_SUPABASE_URL (hosted)', /NEXT_PUBLIC_SUPABASE_URL/);
  expectTargetRejected(hostedEnv({ SUPABASE_URL: PRODUCTION_URL }), 'production in SUPABASE_URL (hosted)', /SUPABASE_URL/);
  expectTargetRejected(localEnv({ NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL }), 'production in NEXT_PUBLIC_SUPABASE_URL (local)', /PRODUCTION/);
});

test('C2 #21 production supplied through a fallback configuration (DB URL, Redis, base URL, env file) is rejected', () => {
  const pooler = `postgresql://postgres.${PROD_REF}:${LOCAL_DB_PASSWORD}@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres`;
  expectTargetRejected(hostedEnv({ DATABASE_URL: pooler }), 'a production pooler DATABASE_URL (hosted)', /DATABASE_URL/);
  expectTargetRejected(localEnv({ SUPABASE_DB_URL: pooler }), 'a production pooler SUPABASE_DB_URL (local)', /SUPABASE_DB_URL/);
  expectTargetRejected(hostedEnv({ AUTH_E2E_BASE_URL: `https://${PROD_REF}.supabase.co` }), 'production as the base URL', /AUTH_E2E_BASE_URL/);
  // The env-file fallback: a production URL coming from the E2E env file is refused too.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e2e-envfile-'));
  const file = path.join(dir, 'e2e.env');
  fs.writeFileSync(file, `E2E_SUPABASE_URL=${PRODUCTION_URL}\n`);
  const saved = process.env.AUTH_E2E_ENV_FILE;
  try {
    process.env.AUTH_E2E_ENV_FILE = file;
    const fromFile: Env = { ...localEnv() };
    const loaded = loadE2EEnvFile(({ path: p }) => {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) fromFile[m[1]] = m[2];
      }
    });
    assert.equal(loaded, file);
    expectTargetRejected(fromFile, 'a production URL loaded from the env file', /PRODUCTION/);
  } finally {
    if (saved === undefined) delete process.env.AUTH_E2E_ENV_FILE;
    else process.env.AUTH_E2E_ENV_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C2 #23 loopback endpoints that are not explicitly allowlisted are rejected', () => {
  for (const url of [
    'http://127.0.0.2:54321',
    'http://0.0.0.0:54321',
    'http://[::ffff:127.0.0.1]:54321',
    'http://0x7f000001:54321',
    'http://2130706433:54321',
    'http://127.1:54321',
    'http://LOCALHOST:54321',
    'http://[0:0:0:0:0:0:0:1]:54321',
  ]) {
    expectTargetRejected(localEnv({ ...allUrls(url) }), url);
  }
});

test('C2 #24 URLs that exploit parsing ambiguity are rejected', () => {
  for (const url of [
    'http://127.0.0.1:54321@evil.example',
    'http://127.0.0.1:54321@evil.example:54321',
    'http://evil.example#@127.0.0.1:54321',
    'http://127.0.0.1\\@evil.example:54321',
    'http://127.0.0.1:54321/../..',
    'http://127.0.0.1:54321/?next=http://evil.example',
    'http://127.0.0.1%2e:54321',
  ]) {
    expectTargetRejected(localEnv({ ...allUrls(url) }), url);
  }
});

test('C2 local: non-loopback app base URL, Redis and database URLs are rejected', () => {
  expectTargetRejected(localEnv({ AUTH_E2E_BASE_URL: 'http://192.168.1.10:3000' }), 'a LAN base URL', /AUTH_E2E_BASE_URL/);
  expectTargetRejected(localEnv({ AUTH_E2E_BASE_URL: 'http://localhost:4000' }), 'an unexpected app port', /AUTH_E2E_BASE_URL/);
  expectTargetRejected(localEnv({ REDIS_URL: 'redis://cache.example.net:6379' }), 'a remote Redis', /REDIS_URL/);
  expectTargetRejected(localEnv({ SUPABASE_DB_URL: `postgresql://postgres:${LOCAL_DB_PASSWORD}@db.example.net:54322/postgres` }), 'a remote DB URL', /SUPABASE_DB_URL/);
  expectTargetRejected(localEnv({ SUPABASE_DB_URL: `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:5432/postgres` }), 'a DB URL on an unexpected port', /SUPABASE_DB_URL/);
});

test('C2 local: missing or placeholder service key, and a hosted-only setting, are rejected', () => {
  expectTargetRejected(localEnv({ E2E_SUPABASE_SECRET_KEY: undefined, SUPABASE_SECRET_KEY: undefined }), 'a missing key', /missing/);
  expectTargetRejected(localEnv({ E2E_SUPABASE_SECRET_KEY: 'placeholder-key', SUPABASE_SECRET_KEY: 'placeholder-key' }), 'a placeholder key', /placeholder/);
  expectTargetRejected(localEnv({ AUTH_E2E_EXPECTED_PROJECT_REF: E2E_REF }), 'AUTH_E2E_EXPECTED_PROJECT_REF in local mode', /AUTH_E2E_EXPECTED_PROJECT_REF/);
});

test('C2 the guard ports equal tests/supabase-local/supabase/config.toml', () => {
  const toml = fs.readFileSync(path.join(__dirname, '..', 'supabase-local', 'supabase', 'config.toml'), 'utf8');
  const portIn = (section: string): number => {
    const block = toml.split(/^\[/m).find((b) => b.startsWith(`${section}]`));
    assert.ok(block, `[${section}] section missing from config.toml`);
    const m = /^port\s*=\s*(\d+)\s*$/m.exec(block as string);
    assert.ok(m, `[${section}].port missing from config.toml`);
    return Number((m as RegExpExecArray)[1]);
  };
  assert.equal(portIn('api'), LOCAL_STACK_PORTS.api);
  assert.equal(portIn('db'), LOCAL_STACK_PORTS.db);
});

// ------------------------------------------------------------ Reachability and no-request guarantees
function fetchSpy(response: { ok: boolean; status: number } | 'throw') {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    if (response === 'throw') throw new Error('connect ECONNREFUSED');
    return response;
  };
  return { calls, impl };
}

test('C2 #22 an unreachable local stack fails closed after exactly one loopback probe, with no fallback', async () => {
  const target = resolveAuthE2ETarget(localEnv());
  for (const behaviour of [{ ok: false, status: 503 }, 'throw' as const]) {
    const spy = fetchSpy(behaviour);
    await assert.rejects(() => assertLocalStackReachable(target, spy.impl), E2EEnvironmentError);
    assert.deepEqual(spy.calls, [`${LOCAL_API}/auth/v1/health`], 'exactly one probe, to the loopback stack only');
  }
  const okSpy = fetchSpy({ ok: true, status: 200 });
  await assertLocalStackReachable(target, okSpy.impl);
  assert.equal(okSpy.calls.length, 1);
});

test('C2 rejected targets never receive a network request, and the probe refuses unvalidated targets', async () => {
  const rejected: Env[] = [
    localEnv({ E2E_SUPABASE_URL: PRODUCTION_URL }),
    localEnv({ E2E_SUPABASE_URL: E2E_URL }),
    localEnv({ ...allUrls('http://192.168.1.10:54321') }),
    localEnv({ AUTH_E2E_TARGET: 'staging' }),
    localEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }),
    hostedEnv({ SUPABASE_URL: PRODUCTION_URL }),
  ];
  const spy = fetchSpy({ ok: true, status: 200 });
  for (const env of rejected) {
    let target: ResolvedAuthE2ETarget | null = null;
    try {
      target = resolveAuthE2ETarget(env);
    } catch {
      target = null;
    }
    assert.equal(target, null, 'resolver must refuse');
    // The harness only ever probes a resolver-produced target, so nothing is contacted.
  }
  const forged = { mode: 'local', supabaseUrl: 'http://evil.example:54321', serviceRoleKey: 'x', baseUrl: '', guard: { projectRef: 'local', hostname: 'evil', description: '' } };
  await assert.rejects(() => assertLocalStackReachable(forged as unknown as ResolvedAuthE2ETarget, spy.impl), E2EEnvironmentError);
  const hosted = resolveAuthE2ETarget(hostedEnv());
  await assert.rejects(() => assertLocalStackReachable(hosted, spy.impl), E2EEnvironmentError);
  assert.equal(spy.calls.length, 0, 'no request may reach any rejected, forged or hosted target');
});

// ------------------------------------------------------------ Harness and preflight refuse to continue (real modules)
const TSX_CLI = path.join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runWithEnv(args: string[], env: Env): { status: number | null; output: string } {
  const base: Env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AUTH_E2E_ENV_FILE: path.join(os.tmpdir(), 'auth-e2e-no-such-env-file') };
  const r = spawnSync(process.execPath, [TSX_CLI, ...args], { cwd: path.join(__dirname, '..', '..'), env: { ...base, ...env } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('C2 the preflight (assertE2ETarget.ts) exits non-zero for a rejected target and zero for a valid local one', () => {
  const bad = runWithEnv(['tests/auth/assertE2ETarget.ts'], localEnv({ NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_URL }));
  assert.notEqual(bad.status, 0, 'preflight must fail');
  assert.match(bad.output, /PRODUCTION/);
  assert.ok(!bad.output.includes(LOCAL_KEY), 'preflight must not print the key');
  const good = runWithEnv(['tests/auth/assertE2ETarget.ts'], localEnv());
  assert.equal(good.status, 0, `valid local target must pass the preflight: ${good.output}`);
  assert.match(good.output, /validated \(local\)/);
});

test('C2 the harness refuses to load (no admin client, no request) when the target is rejected', () => {
  const probe = "import('./tests/auth/authTestHarness.ts').then(() => { console.log('HARNESS_LOADED'); }, (e) => { console.error('HARNESS_REFUSED ' + e.message); process.exit(3); });";
  const bad = runWithEnv(['-e', probe], localEnv({ SUPABASE_URL: PRODUCTION_URL }));
  assert.equal(bad.status, 3, `harness must refuse at module load: ${bad.output}`);
  assert.match(bad.output, /HARNESS_REFUSED/);
  assert.ok(!bad.output.includes('HARNESS_LOADED'));
  const good = runWithEnv(['-e', probe], localEnv());
  assert.match(good.output, /HARNESS_LOADED/, `a valid local target must load the harness: ${good.output}`);
});

// ------------------------------------------------------------ FAILING CONTROLS (mutation)
// Each control removes ONE rule from a scratch copy of the guard and proves that a
// test case above then flips from "rejected" to "accepted", i.e. the rule is
// load-bearing. The real module is never modified.
async function mutantResolve(marker: string, replacement: string, env: Env): Promise<'accepted' | 'rejected'> {
  const source = fs.readFileSync(path.join(__dirname, 'e2eEnvironmentGuard.ts'), 'utf8');
  const count = source.split(marker).length - 1;
  assert.equal(count, 1, `mutation marker must occur exactly once: ${marker}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e2e-c2-mutant-'));
  const file = path.join(dir, 'mutantGuard.ts');
  fs.writeFileSync(file, source.replace(marker, replacement));
  try {
    const mutant = await import(pathToFileURL(file).href);
    try {
      mutant.resolveAuthE2ETarget(env);
      return 'accepted';
    } catch {
      return 'rejected';
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function control(name: string, marker: string, replacement: string, env: Env): Promise<void> {
  expectTargetRejected(env, `${name} (real guard)`);
  assert.equal(await mutantResolve(marker, replacement, env), 'accepted', `${name}: removing the rule must make the case pass, otherwise no test protects it`);
}

const DENIAL_LOOP = 'for (const input of [...urlInputs, ...dbInputs, ...redisInputs, ...overrideInputs]) assertNotDeniedProject(mode, input.name, input.value);';

test('C2 CONTROL production rejected in local mode (denial pass is load-bearing)', async () => {
  await control('production in local mode', DENIAL_LOOP, '/* mutated */', localEnv({ SUPABASE_DB_URL: `postgresql://postgres.${PROD_REF}:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres` }));
});

test('C2 CONTROL production rejected in hosted mode via a secondary variable', async () => {
  await control('production secondary in hosted mode', DENIAL_LOOP, '/* mutated */', hostedEnv({ DATABASE_URL: `postgresql://postgres.${PROD_REF}:${LOCAL_DB_PASSWORD}@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres` }));
});

test('C2 CONTROL legacy E2E rejected in local mode', async () => {
  await control('E2E in local mode', DENIAL_LOOP, '/* mutated */', localEnv({ SUPABASE_DB_URL: `postgresql://postgres.${E2E_REF}:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres` }));
});

test('C2 CONTROL a malformed endpoint is rejected', async () => {
  await control(
    'malformed URL',
    "return fail('local', variable, 'is not a parseable URL.');",
    "return new URL('http://127.0.0.1:54321');",
    localEnv({ ...allUrls('notaurl') }),
  );
});

test('C2 CONTROL a non-loopback endpoint is rejected', async () => {
  await control(
    'LAN host',
    "if (!LOCAL_MODE_LOOPBACK_HOSTS.includes(host)) fail('local', variable, 'is not an allowlisted loopback host.');",
    '/* mutated */',
    localEnv({ ...allUrls('http://192.168.1.10:54321') }),
  );
});

test('C2 CONTROL a non-canonical loopback spelling is rejected (literal authority check)', async () => {
  await control(
    'hex loopback',
    "if (hostPort !== `${host}:${port}`) fail('local', variable, 'has an ambiguous or non-canonical host form; refused.');",
    '/* mutated */',
    localEnv({ ...allUrls('http://0x7f000001:54321') }),
  );
});

test('C2 CONTROL an unknown target mode is rejected', async () => {
  await control(
    'unknown mode',
    "return fail('unresolved', 'AUTH_E2E_TARGET', 'has an unknown value; only \"local\" or \"hosted\" are accepted.');",
    "return 'local';",
    localEnv({ AUTH_E2E_TARGET: 'staging' }),
  );
});

test('C2 CONTROL conflicting target inputs are rejected', async () => {
  await control('conflicting URLs', '} else if (parsed.origin !== canonicalOrigin) {', '} else if (false) {', localEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }));
});

test('C2 CONTROL the probe refuses unvalidated targets (no request to a forged endpoint)', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'e2eEnvironmentGuard.ts'), 'utf8');
  const marker = "if (!isResolvedAuthE2ETarget(target)) throw new E2EEnvironmentError('reachability probe refused";
  assert.equal(source.split(marker).length - 1, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e2e-c2-mutant-'));
  const file = path.join(dir, 'mutantGuard.ts');
  fs.writeFileSync(file, source.replace(marker, "if (false) throw new E2EEnvironmentError('reachability probe refused"));
  try {
    const mutant = await import(pathToFileURL(file).href);
    const forged = { mode: 'local', supabaseUrl: 'http://evil.example:54321', serviceRoleKey: 'x', baseUrl: '', guard: { projectRef: 'local', hostname: 'evil', description: '' } };
    const realSpy = fetchSpy({ ok: true, status: 200 });
    await assert.rejects(() => assertLocalStackReachable(forged as unknown as ResolvedAuthE2ETarget, realSpy.impl), E2EEnvironmentError);
    assert.equal(realSpy.calls.length, 0);
    const mutantSpy = fetchSpy({ ok: true, status: 200 });
    await mutant.assertLocalStackReachable(forged, mutantSpy.impl);
    assert.equal(mutantSpy.calls.length, 1, 'with the brand check removed the forged endpoint IS contacted, so the check is load-bearing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// C2 v2: corrections after the independent review (findings F1, F2, F3, F11).
// Every input the reviewer reported as ACCEPTED is now a regression case.
// =============================================================================
import { denialCandidates } from './e2eEnvironmentGuard';

const PROD_POOLER_HOST = 'aws-1-ap-southeast-1.pooler.supabase.com';

test('C2v2 F1 encoded production refs in SECONDARY variables are rejected (hosted mode)', () => {
  for (const url of [
    'https://klkiseupptzbecbxwrk%79.supabase.co',
    'https://\uff4b\uff4c\uff4b\uff49\uff53\uff45\uff55\uff50\uff50\uff54\uff5a\uff42\uff45\uff43\uff42\uff58\uff57\uff52\uff4b\uff59.supabase.co',
    'https://klkiseupptzbecbx\u00adwrky.supabase.co',
    'https://klkiseupptzbecbx\u200bwrky.supabase.co',
    'https://KLKISEUPPTZBECBXWRKY.supabase.co',
  ]) {
    expectTargetRejected(hostedEnv({ SUPABASE_URL: url }), `hosted SUPABASE_URL ${JSON.stringify(url)}`, /SUPABASE_URL/);
  }
  expectTargetRejected(
    hostedEnv({ DATABASE_URL: `postgresql://postgres.klkiseupptzbecbxwrk%79:${LOCAL_DB_PASSWORD}@${PROD_POOLER_HOST}:6543/postgres` }),
    'a percent-encoded prod ref in the DB user name',
    /DATABASE_URL/,
  );
});

test('C2v2 F1 hosted secondary Supabase URLs must name the same origin as the validated primary', () => {
  expectTargetRejected(hostedEnv({ SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }), 'another (non-production) project in SUPABASE_URL', /different Supabase origin/);
  expectTargetRejected(hostedEnv({ NEXT_PUBLIC_SUPABASE_URL: 'not a url' }), 'an unparseable secondary', /NEXT_PUBLIC_SUPABASE_URL/);
  // The real CI shape (all equal, or only the primary set) still passes.
  assert.equal(resolveAuthE2ETarget(hostedEnv()).mode, 'hosted');
  assert.equal(resolveAuthE2ETarget(hostedEnv({ SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_URL: undefined })).mode, 'hosted');
});

test('C2v2 F1 denialCandidates exposes decoded, normalised and parsed forms', () => {
  assert.ok(denialCandidates('https://klkiseupptzbecbxwrk%79.supabase.co').some((f) => f.includes(PROD_REF)));
  assert.ok(denialCandidates('https://x.example/?y=%6blkiseupptzbecbxwrky').some((f) => f.includes(PROD_REF)));
  assert.ok(denialCandidates('https://\uff4b\uff4c\uff4b\uff49\uff53\uff45\uff55\uff50\uff50\uff54\uff5a\uff42\uff45\uff43\uff42\uff58\uff57\uff52\uff4b\uff59.supabase.co').some((f) => f.includes(PROD_REF)));
  assert.ok(denialCandidates('klkiseupptzbecbx\u00adwrky').some((f) => f.includes(PROD_REF)));
});

test('C2v2 F2 database/Redis URLs may not carry a query, fragment or extra path (they can override the host)', () => {
  const base = `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres`;
  for (const suffix of ['?host=evil.example.com', '?hostaddr=203.0.113.7', '?port=6543', '?sslmode=disable', '#frag', '/extra', '/../postgres', `?host=${PROD_POOLER_HOST}`]) {
    expectTargetRejected(localEnv({ SUPABASE_DB_URL: base + suffix }), `DB URL with ${suffix}`, /SUPABASE_DB_URL/);
  }
  expectTargetRejected(
    localEnv({ SUPABASE_DB_URL: `postgresql://postgres.klkiseupptzbecbxwrk%79:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres?host=aws-1-ap-southeast-1.pooler%2esupabase%2ecom&port=6543` }),
    "the reviewer's combined F1+F2 input",
  );
  assert.equal(resolveAuthE2ETarget(localEnv({ SUPABASE_DB_URL: base })).mode, 'local', 'a plain loopback DB URL is still accepted');
  expectTargetRejected(localEnv({ REDIS_URL: 'redis://127.0.0.1:6379/0?host=evil.example' }), 'a Redis URL with a query', /REDIS_URL/);
  assert.equal(resolveAuthE2ETarget(localEnv({ REDIS_URL: 'redis://127.0.0.1:6379/0' })).mode, 'local');
});

test('C2v2 F3 local mode governs the app server inputs (URL vars, secret key, pooler, ENV_FILE, env files)', () => {
  expectTargetRejected(localEnv({ SUPABASE_URL: undefined }), 'SUPABASE_URL left unset', /SUPABASE_URL/);
  expectTargetRejected(localEnv({ NEXT_PUBLIC_SUPABASE_URL: undefined }), 'NEXT_PUBLIC_SUPABASE_URL left unset', /NEXT_PUBLIC_SUPABASE_URL/);
  expectTargetRejected({ AUTH_E2E_TARGET: 'local', E2E_SUPABASE_URL: LOCAL_API, E2E_SUPABASE_SECRET_KEY: LOCAL_KEY }, "only the E2E_* variables (the reviewer's input)");
  expectTargetRejected(localEnv({ SUPABASE_SECRET_KEY: undefined }), 'SUPABASE_SECRET_KEY unset', /SUPABASE_SECRET_KEY/);
  expectTargetRejected(localEnv({ SUPABASE_SECRET_KEY: 'a-different-key-value-0000000001' }), 'SUPABASE_SECRET_KEY differing from the selected key', /SUPABASE_SECRET_KEY/);
  expectTargetRejected(localEnv({ SUPABASE_POOLER_URL: `postgresql://postgres.${PROD_REF}:${LOCAL_DB_PASSWORD}@${PROD_POOLER_HOST}:6543/postgres` }), 'a production SUPABASE_POOLER_URL', /SUPABASE_POOLER_URL/);
  expectTargetRejected(localEnv({ SUPABASE_POOLER_URL: `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres` }), 'any SUPABASE_POOLER_URL in local mode', /SUPABASE_POOLER_URL/);
  expectTargetRejected(localEnv({ ENV_FILE: '.env.local' }), 'ENV_FILE in local mode', /ENV_FILE/);
  for (const file of ['.env', '.env.local', '.env.cert', '.env.development', '.env.development.local', '.env.e2e']) {
    assert.throws(
      () => resolveAuthE2ETarget(localEnv(), { cwd: '/app', fileExists: (p) => p.split('\\').join('/').endsWith(`/app/${file}`) }),
      (e: unknown) => e instanceof E2EEnvironmentError && (e as Error).message.includes(file),
      `${file} present must be refused in local mode`,
    );
  }
  assert.equal(resolveAuthE2ETarget(localEnv(), { cwd: '/app', fileExists: () => false }).mode, 'local');
  expectTargetRejected(
    hostedEnv({ SUPABASE_POOLER_URL: `postgresql://postgres.${PROD_REF}:${LOCAL_DB_PASSWORD}@${PROD_POOLER_HOST}:6543/postgres` }),
    'a production pooler URL in hosted mode',
    /SUPABASE_POOLER_URL/,
  );
});

test('C2v2 F11 a whitespace-only target variable is an error, never a fallback', () => {
  expectTargetRejected(hostedEnv({ E2E_SUPABASE_URL: '   ' }), "a blank primary in hosted mode (the reviewer's input)", /blank/);
  expectTargetRejected(localEnv({ NEXT_PUBLIC_SUPABASE_URL: ' \t ' }), 'a blank secondary in local mode', /blank/);
  expectTargetRejected(hostedEnv({ E2E_SUPABASE_SECRET_KEY: '  ' }), 'a blank key', /blank/);
});

// ---------------- v2 failing controls ----------------
type Mutation = readonly [marker: string, replacement: string];

async function mutantResolveWith(mutations: readonly Mutation[], env: Env, options?: Record<string, unknown>): Promise<'accepted' | 'rejected'> {
  let source = fs.readFileSync(path.join(__dirname, 'e2eEnvironmentGuard.ts'), 'utf8');
  for (const [marker, replacement] of mutations) {
    assert.equal(source.split(marker).length - 1, 1, `mutation marker must occur exactly once: ${marker}`);
    source = source.replace(marker, replacement);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e2e-c2v2-mutant-'));
  const file = path.join(dir, 'mutantGuard.ts');
  fs.writeFileSync(file, source);
  try {
    const mutant = await import(pathToFileURL(file).href);
    try {
      mutant.resolveAuthE2ETarget(env, options);
      return 'accepted';
    } catch {
      return 'rejected';
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function controlV2(name: string, mutations: readonly Mutation[], env: Env, options?: Record<string, unknown>): Promise<void> {
  assert.throws(() => resolveAuthE2ETarget(env, options as never), E2EEnvironmentError, `${name}: the real guard must reject`);
  assert.equal(await mutantResolveWith(mutations, env, options), 'accepted', `${name}: removing the rule must make the case pass, otherwise no test protects it`);
}

const ENCODED_PROD_DB = `postgresql://postgres.klkiseupptzbecbxwrk%79:${LOCAL_DB_PASSWORD}@${PROD_POOLER_HOST}:6543/postgres`;

test('C2v2 CONTROL decoded/normalised denial forms are load-bearing (F1)', async () => {
  await controlV2('encoded prod ref', [['export function denialCandidates(value: string): string[] {', 'export function denialCandidates(value: string): string[] {\n  return [value.toLowerCase()];']], hostedEnv({ DATABASE_URL: ENCODED_PROD_DB }));
});

test('C2v2 CONTROL hosted secondary-origin equality is load-bearing (F1)', async () => {
  await controlV2('secondary origin', [['if (origin !== primaryOrigin) fail(', 'if (false) fail(']], hostedEnv({ SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }));
});

const QUERY_CHECK = "if (rawRest.includes('?') || rawRest.includes('#') || parsed.search || parsed.hash) {";
const PATH_CHECK = "if (!rule.pathPattern.test(rawRest)) fail(";
const STRICT_TEXT_CHECK = "if (!STRICT_LOCAL_URL_CHARS.test(raw)) fail(";

test('C2v2 CONTROL the path pattern is load-bearing (F2)', async () => {
  await controlV2('db extra path', [[PATH_CHECK, 'if (false) fail(']], localEnv({ SUPABASE_DB_URL: `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres/extra` }));
});

test('C2v2 CONTROL the query/fragment refusal (with the path pattern) is load-bearing (F2)', async () => {
  // The path pattern also refuses "?", so both layers are removed to prove the case is guarded at all;
  // with only one removed, the other still rejects (defence in depth).
  const env = localEnv({ SUPABASE_DB_URL: `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres?host=evil.example.com` });
  // v3: the strict character check (F8) is a third layer; "?" and "=" are outside its set.
  const STRICT = [STRICT_TEXT_CHECK, 'if (false) fail('] as const;
  assert.equal(await mutantResolveWith([[QUERY_CHECK, 'if (false) {'], STRICT], env), 'rejected', 'the path pattern alone still refuses a query');
  assert.equal(await mutantResolveWith([[PATH_CHECK, 'if (false) fail('], STRICT], env), 'rejected', 'the query check alone still refuses a query');
  assert.equal(await mutantResolveWith([[QUERY_CHECK, 'if (false) {'], [PATH_CHECK, 'if (false) fail(']], env), 'rejected', 'the strict character check alone still refuses a query');
  await controlV2('db ?host=', [[QUERY_CHECK, 'if (false) {'], [PATH_CHECK, 'if (false) fail('], STRICT], env);
});

test('C2v2 CONTROL the app-override refusal is load-bearing (F3)', async () => {
  await controlV2('pooler in local', [['for (const input of overrideInputs) fail(', 'for (const input of []) fail(']], localEnv({ SUPABASE_POOLER_URL: `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres` }));
});

test('C2v2 CONTROL the env-file refusal is load-bearing (F3)', async () => {
  const opts = { cwd: '/app', fileExists: (p: string) => p.split('\\').join('/').endsWith('/app/.env.local') };
  await controlV2('.env.local present', [['if (exists(join(cwd, file))) fail(', 'if (false) fail(']], localEnv(), opts);
});

test('C2v2 CONTROL the required app URL variables are load-bearing (F3)', async () => {
  await controlV2('SUPABASE_URL unset', [['if (!urlInputs.some((i) => i.name === required)) fail(', 'if (false) fail(']], localEnv({ SUPABASE_URL: undefined }));
});

test('C2v2 CONTROL the secret-key equality is load-bearing (F3)', async () => {
  await controlV2('key mismatch', [["if (present(env, 'SUPABASE_SECRET_KEY') !== serviceRoleKey) {", 'if (false) {']], localEnv({ SUPABASE_SECRET_KEY: 'a-different-key-value-0000000001' }));
});

test('C2v2 CONTROL the blank-variable refusal is load-bearing (F11)', async () => {
  await controlV2('blank primary', [["if (typeof raw === 'string' && raw.trim() === '' && raw !== '') fail(", 'if (false) fail(']], hostedEnv({ E2E_SUPABASE_URL: '   ' }));
});

// =============================================================================
// C2 v3: final hardening (review findings F4, F5, F8, F9, F10, F12, F15).
// Every rule has a negative test; every rule added here has a failing control.
// =============================================================================
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import realDotenv from 'dotenv';
import { createGuardedAdminFetch, decodeJwtClaims, PRODUCTION_REDIS_HOSTNAMES } from './e2eEnvironmentGuard';

const PROD_REDIS = 'rediss://default:upstash-pw@noble-dane-77325.upstash.io:6379';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;
}
const LOCAL_DEMO_JWT = jwt({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 });
const PROD_JWT = jwt({ iss: 'supabase', ref: PROD_REF, role: 'service_role' });
const OTHER_PROJECT_JWT = jwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'service_role' });
const E2E_PROJECT_JWT = jwt({ iss: 'supabase', ref: E2E_REF, role: 'service_role' });
const keyEnv = (key: string): Env => ({ E2E_SUPABASE_SECRET_KEY: key, SUPABASE_SECRET_KEY: key });
// Opaque-key fixtures are assembled at run time so no source line looks like a real secret key to a scanner.
const OPAQUE_KEY_PREFIX = ['sb', 'secret', ''].join('_');

/** Like expectTargetRejected, and additionally proves the given value never appears in the message. */
function expectRejectedWithout(env: Env, why: string, secret: string, mustMention?: RegExp): void {
  assert.throws(
    () => resolveAuthE2ETarget(env),
    (e: unknown) => {
      if (!(e instanceof E2EEnvironmentError)) return false;
      assert.ok(!e.message.includes(secret), `the error for ${why} echoed the value`);
      if (mustMention) assert.match(e.message, mustMention, why);
      return true;
    },
    why,
  );
}

// ---------------- F4: every connection variable the app reads ----------------
test('C2v3 F4 the production Redis host is refused in every mode and every Redis variable', () => {
  assert.ok(PRODUCTION_REDIS_HOSTNAMES.includes('noble-dane-77325.upstash.io'));
  expectRejectedWithout(hostedEnv({ REDIS_URL: PROD_REDIS }), 'prod Redis in REDIS_URL (hosted, the reviewer\'s input)', 'upstash-pw', /PRODUCTION Redis/);
  expectRejectedWithout(hostedEnv({ CREATOR_RENDER_REDIS_URL: PROD_REDIS }), 'prod Redis in CREATOR_RENDER_REDIS_URL (hosted)', 'upstash-pw', /PRODUCTION Redis/);
  expectRejectedWithout(hostedEnv({ SOME_OTHER_REDIS_URL: PROD_REDIS }), 'prod Redis in an unknown Redis variable (hosted)', 'upstash-pw', /PRODUCTION Redis/);
  expectRejectedWithout(hostedEnv({ REDIS_URL: 'rediss://default:pw@NOBLE-DANE-77325.UPSTASH.IO:6379' }), 'upper-case prod Redis host', 'pw@', /PRODUCTION Redis/);
  expectRejectedWithout(localEnv({ REDIS_HOST: 'noble-dane-77325.upstash.io' }), 'REDIS_HOST=prod (local, the reviewer\'s input)', 'noble', /REDIS_HOST/);
});

test('C2v3 F4 local mode refuses every enumerated app connection override, and requires REDIS_URL', () => {
  const loopbackDb = `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres`;
  for (const [name, value] of [
    ['GROUNDING_STORE_DSN', loopbackDb],
    ['W6_DB_URL', `postgresql://postgres:${LOCAL_DB_PASSWORD}@db.${PROD_REF}.supabase.co:5432/postgres`],
    ['DIRECT_URL', loopbackDb], ['MIGRATION_DATABASE_URL', loopbackDb], ['TEST_DATABASE_URL', loopbackDb], ['SUPABASE_POOLER_DB_URL', loopbackDb],
    ['CERT_DB_URL', loopbackDb], ['ACTOR_FK_DB_URL', loopbackDb], ['BETA_SUPABASE_URL', LOCAL_API],
    ['CREATOR_RENDER_REDIS_URL', 'redis://127.0.0.1:6379'], ['REDIS_PRIVATE_URL', 'redis://127.0.0.1:6379'],
    ['REDIS_HOST', '127.0.0.1'], ['REDIS_PORT', '6379'], ['REDIS_PASSWORD', 'x'],
    ['UPSTASH_REDIS_URL', 'redis://127.0.0.1:6379'], ['UPSTASH_REDIS_REST_URL', 'http://127.0.0.1:8079'],
    ['DOTENV_KEY', 'dotenv://:key_x@dotenv.local/vault/.env.vault?environment=development'],
    ['ALLOW_PROD_DB_WITH_LOCAL_REDIS', '1'],
    ['HTTP_PROXY', 'http://proxy.example:3128'], ['https_proxy', 'http://proxy.example:3128'], ['NODE_USE_ENV_PROXY', '1'],
  ] as const) {
    expectTargetRejected(localEnv({ [name]: value }), `${name} in local mode`, new RegExp(name));
  }
  expectTargetRejected(localEnv({ REDIS_URL: undefined }), 'REDIS_URL unset in local mode', /REDIS_URL/);
});

test('C2v3 F4 local mode refuses UNKNOWN connection-like variables; known non-connection settings pass', () => {
  for (const name of ['FOO_DATABASE_URL', 'ANALYTICS_REDIS_URL', 'KV_URL', 'REPORTING_DSN', 'X_DB_URL', 'DB_URL', 'POSTGRES_URL', 'SOAK_REDIS_HOST']) {
    expectTargetRejected(localEnv({ [name]: 'anything' }), `${name} in local mode`, /unrecognised connection variable/);
  }
  assert.equal(resolveAuthE2ETarget(localEnv({ UPSTASH_DAILY_REQUEST_LIMIT: '1000', ENABLE_REDIS_USAGE_MONITORING: '0', REDIS_WAIT_MS: '10', DEV_AUTO_START_REDIS: '0' })).mode, 'local');
  // hosted mode does not refuse unknown names (the hosted job is unchanged) but denial-checks their values
  assert.equal(resolveAuthE2ETarget(hostedEnv({ FOO_DATABASE_URL: 'postgresql://u:p@db.example.net:5432/x' })).mode, 'hosted');
  expectTargetRejected(hostedEnv({ FOO_DATABASE_URL: `postgresql://postgres.${PROD_REF}:p@x.example:5432/x` }), 'prod ref in an unknown DB variable (hosted)', /FOO_DATABASE_URL/);
});

// ---------------- F15: PG* and SUPABASE_* overrides ----------------
test('C2v3 F15 libpq / node-postgres PG* variables are refused in local mode, whatever their case', () => {
  for (const name of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGSYSCONFDIR', 'PGPASSFILE', 'PGPASSWORD', 'PGDATABASE', 'PGUSER', 'PGOPTIONS', 'PGSSLMODE', 'pghost']) {
    expectRejectedWithout(localEnv({ [name]: '203.0.113.77' }), `${name} in local mode`, '203.0.113.77', new RegExp(name));
  }
});

// ---------------- F5: JWT project binding ----------------
test('C2v3 F5 a JWT key bound to production, or to any hosted project, is refused in local mode (values never echoed)', () => {
  assert.deepEqual(decodeJwtClaims(PROD_JWT), { iss: 'supabase', ref: PROD_REF, role: 'service_role' });
  assert.equal(decodeJwtClaims(OPAQUE_KEY_PREFIX + 'opaqueValue123'), null, 'opaque keys have no readable claims');
  expectRejectedWithout(localEnv(keyEnv(PROD_JWT)), 'production JWT as the local key (the reviewer\'s input)', PROD_JWT);
  expectRejectedWithout(localEnv(keyEnv(OTHER_PROJECT_JWT)), 'another hosted project JWT as the local key', OTHER_PROJECT_JWT, /hosted project|"ref"/);
  expectRejectedWithout(localEnv(keyEnv(jwt({ iss: 'supabase', role: 'service_role' }))), 'a hosted-issuer JWT without ref', 'eyJ', /supabase-demo/);
  expectRejectedWithout(localEnv(keyEnv('aaaa.bbbb.cccc')), 'a JWT-shaped key with an unreadable payload', 'aaaa.bbbb', /not a readable claims object/);
  expectRejectedWithout(localEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: PROD_JWT }), 'production anon JWT for the app', PROD_JWT, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  expectRejectedWithout(localEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${PROD_REF}` }), 'a key text naming production', PROD_REF);
  assert.equal(resolveAuthE2ETarget(localEnv(keyEnv(LOCAL_DEMO_JWT))).mode, 'local', 'a local-stack (supabase-demo) JWT is accepted');
  assert.equal(resolveAuthE2ETarget(localEnv(keyEnv(OPAQUE_KEY_PREFIX + 'localOpaqueFixture0123456789'))).mode, 'local', 'an opaque local key is accepted');
});

test('C2v3 F5 hosted mode: a JWT for production or for a different project is refused; the E2E project JWT passes', () => {
  expectRejectedWithout(hostedEnv({ E2E_SUPABASE_SECRET_KEY: PROD_JWT }), 'production JWT (hosted)', PROD_JWT);
  expectRejectedWithout(hostedEnv({ E2E_SUPABASE_SECRET_KEY: OTHER_PROJECT_JWT }), 'other-project JWT (hosted)', OTHER_PROJECT_JWT, /different project/);
  expectRejectedWithout(hostedEnv({ SUPABASE_SERVICE_ROLE_KEY: PROD_JWT }), 'production JWT in a fallback key variable (hosted)', PROD_JWT);
  assert.equal(resolveAuthE2ETarget(hostedEnv({ E2E_SUPABASE_SECRET_KEY: E2E_PROJECT_JWT })).mode, 'hosted');
  assert.equal(resolveAuthE2ETarget(hostedEnv()).mode, 'hosted', 'the existing hosted shape is unchanged');
});

// ---------------- F8: one interpretation ----------------
test('C2v3 F8 local values that URL parsers interpret differently are refused on the RAW value', () => {
  const db = `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres`;
  for (const [name, value] of [
    ['SUPABASE_URL', 'http://127.0.0.1:54321\t'],
    ['SUPABASE_URL', ' http://127.0.0.1:54321'],
    ['SUPABASE_URL', 'http://127.0.0.1:54321\n'],
    ['SUPABASE_URL', 'http://127.0.0.1:54321\\'],
    ['SUPABASE_URL', 'http://127.0.0.1:5432١'],
    ['SUPABASE_URL', 'http://127.0.0.1:54321/​'],
    ['SUPABASE_DB_URL', 'postgresql://a@evil.example:5432@127.0.0.1:54322/postgres'],
    ['SUPABASE_DB_URL', `${db}\r`],
    ['REDIS_URL', 'redis://127.0.0.1:6379\t'],
    ['AUTH_E2E_BASE_URL', 'http://localhost:3000 '],
  ] as const) {
    expectTargetRejected(localEnv(name === 'SUPABASE_URL' ? { ...allUrls(value) } : { [name]: value }), `${name}=${JSON.stringify(value)}`);
  }
  // The harness uses exactly the validated origin (serialised by the clients' own parser).
  assert.equal(resolveAuthE2ETarget(localEnv({ ...allUrls('http://127.0.0.1:54321/') })).supabaseUrl, 'http://127.0.0.1:54321');
});

// ---------------- F9/F10: the guarded admin fetch ----------------
type SpyCall = { url: string; redirect: unknown; apikey: string | null };
function adminSpy(answer: (url: string) => Response) {
  const calls: SpyCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(typeof input === 'object' && !(input instanceof URL) ? input.headers : init?.headers);
    calls.push({ url, redirect: typeof input === 'object' && !(input instanceof URL) ? input.redirect : init?.redirect, apikey: headers.get('apikey') });
    return answer(url);
  };
  return { calls, impl };
}

test('C2v3 F10 the guarded admin fetch: validated origin only, readiness first, never follows a redirect', async () => {
  const target = resolveAuthE2ETarget(localEnv());
  const ok = adminSpy(() => new Response('{}', { status: 200 }));
  const order: string[] = [];
  const guarded = createGuardedAdminFetch(target, ok.impl, () => { order.push('ready'); });
  await guarded(`${LOCAL_API}/auth/v1/admin/users`, { headers: { apikey: 'K' } });
  assert.deepEqual(order, ['ready']);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].redirect, 'manual', 'every admin request is sent with redirect "manual"');
  // other origins are refused before any request
  for (const url of ['http://localhost:54321/auth/v1/admin/users', 'http://127.0.0.1:54322/', 'https://evil.example/', `${PRODUCTION_URL}/auth/v1/admin/users`]) {
    await assert.rejects(() => guarded(url), /not the validated Supabase origin/);
  }
  await assert.rejects(() => guarded(new Request('https://evil.example/x')), /not the validated Supabase origin/);
  assert.equal(ok.calls.length, 1, 'no request reached any other origin');
  // a redirect answer is refused
  const redirecting = adminSpy(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
  await assert.rejects(() => createGuardedAdminFetch(target, redirecting.impl)(`${LOCAL_API}/auth/v1/admin/users`, { headers: { apikey: 'K' } }), /redirect/);
  assert.equal(redirecting.calls.length, 1, 'the redirect location is never requested');
  // a failing readiness gate means no request at all
  const gated = adminSpy(() => new Response('{}', { status: 200 }));
  await assert.rejects(() => createGuardedAdminFetch(target, gated.impl, () => { throw new Error('stack down'); })(`${LOCAL_API}/x`), /stack down/);
  assert.equal(gated.calls.length, 0);
  // only a resolver-produced target is accepted
  const forged = { mode: 'local', supabaseUrl: LOCAL_API, supabaseUrlVariable: 'E2E_SUPABASE_URL', serviceRoleKey: LOCAL_KEY, baseUrl: 'http://localhost:3000', guard: target.guard };
  assert.throws(() => createGuardedAdminFetch(forged as unknown as ResolvedAuthE2ETarget, ok.impl), E2EEnvironmentError);
});

/** Real HTTP: server A answers 302 to server B; B records whatever reaches it. */
async function redirectServers(): Promise<{ portA: number; received: Array<Record<string, string | string[] | undefined>>; close: () => Promise<void> }> {
  const received: Array<Record<string, string | string[] | undefined>> = [];
  const b = http.createServer((req, res) => { received.push(req.headers); res.end('{}'); });
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', r));
  const portB = (b.address() as AddressInfo).port;
  const a = http.createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${portB}/steal` }); res.end(); });
  await new Promise<void>((r) => a.listen(0, '127.0.0.1', r));
  const portA = (a.address() as AddressInfo).port;
  return { portA, received, close: async () => { await new Promise((r) => a.close(r)); await new Promise((r) => b.close(r)); } };
}

async function redirectLeak(guardModule: { createGuardedAdminFetch: typeof createGuardedAdminFetch; resolveAuthE2ETarget: typeof resolveAuthE2ETarget }): Promise<{ threw: boolean; leakedApikey: boolean }> {
  const servers = await redirectServers();
  try {
    const target = guardModule.resolveAuthE2ETarget(localEnv());
    // The real undici fetch, pointed at server A in place of the validated origin.
    // The guard hands over ONE Request; re-target it to server A, keeping every option (incl. redirect).
    const viaA = (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return fetch(new Request(req.url.replace(LOCAL_API, `http://127.0.0.1:${servers.portA}`), req));
    };
    let threw = false;
    try {
      await guardModule.createGuardedAdminFetch(target, viaA)(`${LOCAL_API}/auth/v1/admin/users`, { headers: { apikey: 'SERVICE-KEY-MUST-NOT-LEAK', Authorization: 'Bearer SERVICE-KEY-MUST-NOT-LEAK' } });
    } catch {
      threw = true;
    }
    return { threw, leakedApikey: servers.received.some((h) => h.apikey === 'SERVICE-KEY-MUST-NOT-LEAK') };
  } finally {
    await servers.close();
  }
}

test('C2v3 F10 real HTTP: a 302 from the admin endpoint is refused and the apikey never reaches the redirect target', async () => {
  const r = await redirectLeak({ createGuardedAdminFetch, resolveAuthE2ETarget });
  assert.deepEqual(r, { threw: true, leakedApikey: false });
});

async function importGuardMutant(mutations: ReadonlyArray<readonly [string, string]>) {
  let source = fs.readFileSync(path.join(__dirname, 'e2eEnvironmentGuard.ts'), 'utf8');
  for (const [marker, replacement] of mutations) {
    assert.equal(source.split(marker).length - 1, 1, `mutation marker must occur exactly once: ${marker}`);
    source = source.replace(marker, replacement);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e2e-c2v3-mutant-'));
  const file = path.join(dir, 'mutantGuard.ts');
  fs.writeFileSync(file, source);
  return { mod: await import(pathToFileURL(file).href), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('C2v3 CONTROL F10 without the redirect guard, the real fetch DOES forward the apikey to the redirect target', async () => {
  const { mod, done } = await importGuardMutant([
    ["      request = new Request(input, { ...init, redirect: 'manual' });", "      request = new Request(input, { ...init, redirect: 'follow' });"],
    ["if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {", 'if (false) {'],
  ]);
  try {
    const r = await redirectLeak(mod);
    assert.equal(r.leakedApikey, true, 'the control must observe the leak (undici strips Authorization cross-origin but not apikey)');
  } finally {
    done();
  }
});

// ---------------- F9 + F12: the harness itself, in a child process with an intercepted fetch ----------------
const HARNESS = path.join(__dirname, 'authTestHarness.ts');

function harnessChild(env: Env, fetchMode: 'down' | 'up' | 'redirect', script: string, harnessFile = HARNESS): { status: number | null; output: string; result: { calls: SpyCall[]; out: Record<string, string> } | null } {
  const code = [
    'const calls = [];',
    `const mode = ${JSON.stringify(fetchMode)};`,
    'globalThis.fetch = async (input, init) => {',
    "  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;",
    "  const headers = new Headers(typeof input === 'object' && !(input instanceof URL) ? input.headers : init?.headers);",
    "  calls.push({ url, redirect: (typeof input === 'object' && !(input instanceof URL) ? input.redirect : init?.redirect) ?? null, apikey: headers.get('apikey') ? 'present' : null });",
    "  if (url.endsWith('/auth/v1/health')) return new Response('{}', { status: mode === 'down' ? 503 : 200 });",
    "  if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://evil.example/steal' } });",
    "  return new Response(JSON.stringify({ users: [], aud: 'authenticated' }), { status: 200, headers: { 'content-type': 'application/json' } });",
    '};',
    'const out = {};',
    `import(${JSON.stringify(pathToFileURL(harnessFile).href)}).then(async (m) => {`,
    "  const h = m.adminSupabase ? m : m.default; // a CJS-compiled module exposes its exports under default",
    script,
    "  console.log('RESULT ' + JSON.stringify({ calls, out }));",
    "}, (e) => { console.log('RESULT ' + JSON.stringify({ calls, out: { load: 'refused: ' + e.message } })); });",
  ].join('\n');
  const r = runWithEnv(['-e', code], env);
  const m = /RESULT (\{.*\})/.exec(r.output);
  return { ...r, result: m ? JSON.parse(m[1]) : null };
}

const ADMIN_LIST = "  try { const r = await h.adminSupabase.auth.admin.listUsers(); out.list = r.error ? 'error: ' + r.error.message : 'ok'; } catch (e) { out.list = 'threw: ' + e.message; }";
const DEV_SERVER = "  try { await h.assertDevServer(); out.dev = 'ok'; } catch (e) { out.dev = 'threw: ' + e.message; }";
const isAdmin = (c: SpyCall) => c.url.includes('/auth/v1/admin');

test('C2v3 F9 a down local stack: NO admin request and NO dev-server request is ever made (probe first, memoised)', () => {
  const r = harnessChild(localEnv(), 'down', `${ADMIN_LIST}\n${DEV_SERVER}\n  try { await h.warmAuthRoutes(); out.warm = 'ok'; } catch (e) { out.warm = 'threw: ' + e.message; }`);
  assert.ok(r.result, r.output);
  assert.deepEqual(r.result!.calls.map((c) => c.url), [`${LOCAL_API}/auth/v1/health`], `only the single probe may be sent: ${JSON.stringify(r.result!.calls)}`);
  assert.equal(r.result!.calls[0].redirect, 'manual');
  assert.match(r.result!.out.list, /not reachable/);
  assert.match(r.result!.out.dev, /not reachable/);
  assert.match(r.result!.out.warm, /not reachable/);
});

test('C2v3 F10 harness: an admin request answered with a redirect is refused; the location is never requested', () => {
  const r = harnessChild(localEnv(), 'redirect', ADMIN_LIST);
  assert.ok(r.result, r.output);
  const calls = r.result!.calls;
  assert.ok(calls.some(isAdmin), 'the admin request was attempted');
  for (const c of calls.filter(isAdmin)) assert.equal(c.redirect, 'manual');
  assert.ok(!calls.some((c) => c.url.includes('evil.example')), 'the redirect location was never requested');
  assert.match(r.result!.out.list, /redirect/);
});

test('C2v3 F12 a rejected target: the harness refuses to load and NO request of any kind is made', () => {
  for (const env of [localEnv({ SUPABASE_URL: PRODUCTION_URL }), localEnv({ PGHOSTADDR: '203.0.113.7' }), localEnv(keyEnv(PROD_JWT)), hostedEnv({ REDIS_URL: PROD_REDIS })]) {
    const r = harnessChild(env, 'up', ADMIN_LIST);
    assert.ok(r.result, r.output);
    assert.match(r.result!.out.load ?? '', /refused/);
    assert.deepEqual(r.result!.calls, [], 'no request may be made for a rejected target');
  }
});

test('C2v3 F12 assertGuardedAdminCall: a target that changes after load is refused before any admin request', () => {
  const r = harnessChild(localEnv(), 'up', [
    "  for (const k of ['E2E_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']) process.env[k] = 'http://localhost:54321';",
    "  try { await h.createConfirmedUser('changed-' + Date.now() + '@qa.co'); out.create = 'ok'; } catch (e) { out.create = 'threw: ' + e.message; }",
  ].join('\n'));
  assert.ok(r.result, r.output);
  assert.match(r.result!.out.create, /changed after module load/);
  assert.ok(!r.result!.calls.some(isAdmin), 'no admin request after the target changed');
});

function withHarnessMutant<T>(mutations: ReadonlyArray<readonly [string, string]>, fn: (file: string) => T): T {
  let source = fs.readFileSync(HARNESS, 'utf8');
  for (const [marker, replacement] of mutations) {
    assert.equal(source.split(marker).length - 1, 1, `mutation marker must occur exactly once: ${marker}`);
    source = source.replace(marker, replacement);
  }
  // Same directory so the relative imports resolve; removed in finally.
  const file = path.join(__dirname, `.mutant-harness-${process.pid}-${Date.now()}.ts`);
  fs.writeFileSync(file, source);
  try {
    return fn(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

test('C2v3 CONTROL F9 without the guarded fetch, the admin client DOES contact a down stack\'s admin API', () => {
  withHarnessMutant([['  global: { fetch: guardedAdminFetch },\n', '']], (file) => {
    const r = harnessChild(localEnv(), 'down', ADMIN_LIST, file);
    assert.ok(r.result, r.output);
    assert.ok(r.result!.calls.some(isAdmin), 'the control must observe an admin request without the gate');
  });
});

test('C2v3 CONTROL F10 without the guarded fetch, the admin client follows redirects (redirect is not "manual")', () => {
  withHarnessMutant([['  global: { fetch: guardedAdminFetch },\n', '']], (file) => {
    const r = harnessChild(localEnv(), 'redirect', ADMIN_LIST, file);
    assert.ok(r.result, r.output);
    const admin = r.result!.calls.filter(isAdmin);
    assert.ok(admin.length > 0 && admin.every((c) => c.redirect !== 'manual'), `the control must observe follow-mode requests: ${JSON.stringify(admin)}`);
  });
});

test('C2v3 CONTROL F12 assertGuardedAdminCall is load-bearing', () => {
  withHarnessMutant([['    const again = resolveAuthE2ETarget(process.env);\n    if (again.mode !== resolvedTarget.mode || again.supabaseUrl !== supabaseUrl) {', '    const again = resolvedTarget;\n    if (again.mode !== resolvedTarget.mode || again.supabaseUrl !== supabaseUrl) {']], (file) => {
    const r = harnessChild(localEnv(), 'up', [
      "  for (const k of ['E2E_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']) process.env[k] = 'http://localhost:54321';",
      "  try { await h.createConfirmedUser('changed-' + Date.now() + '@qa.co'); out.create = 'ok'; } catch (e) { out.create = 'threw: ' + e.message; }",
    ].join('\n'), file);
    assert.ok(r.result, r.output);
    assert.ok(r.result!.calls.some(isAdmin), 'the control must observe an admin request after the target changed');
  });
});

// ---------------- F12: probe init, real dotenv override ----------------
test('C2v3 F12 the probe sends redirect "manual" and the apikey, to the validated origin only', async () => {
  const seen: Array<{ url: string; init: unknown }> = [];
  await assertLocalStackReachable(resolveAuthE2ETarget(localEnv()), async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 }; });
  assert.deepEqual(seen, [{ url: `${LOCAL_API}/auth/v1/health`, init: { method: 'GET', headers: { apikey: LOCAL_KEY }, redirect: 'manual' } }]);
});

test('C2v3 CONTROL F12 the probe redirect mode is load-bearing', async () => {
  const { mod, done } = await importGuardMutant([["headers: { apikey: target.serviceRoleKey }, redirect: 'manual' })", 'headers: { apikey: target.serviceRoleKey } })']]);
  try {
    const seen: unknown[] = [];
    await mod.assertLocalStackReachable(mod.resolveAuthE2ETarget(localEnv()), async (_url: string, init: unknown) => { seen.push(init); return { ok: true, status: 200 }; });
    assert.equal((seen[0] as { redirect?: string }).redirect, undefined, 'the control must observe the missing redirect mode');
  } finally {
    done();
  }
});

function withEnvFile<T>(content: string, fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-e2e-envfile-v3-'));
  const file = path.join(dir, 'e2e.env');
  fs.writeFileSync(file, content);
  const saved = { file: process.env.AUTH_E2E_ENV_FILE, url: process.env.E2E_SUPABASE_URL };
  try {
    process.env.AUTH_E2E_ENV_FILE = file;
    process.env.E2E_SUPABASE_URL = LOCAL_API; // a stray value already in the shell
    return fn();
  } finally {
    for (const [k, v] of [['AUTH_E2E_ENV_FILE', saved.file], ['E2E_SUPABASE_URL', saved.url]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('C2v3 F12 with the REAL dotenv, the E2E env file is authoritative (override) and its production URL is refused', () => {
  withEnvFile(`E2E_SUPABASE_URL=${PRODUCTION_URL}\n`, () => {
    assert.ok(loadE2EEnvFile(realDotenv.config as never));
    assert.equal(process.env.E2E_SUPABASE_URL, PRODUCTION_URL, 'the file value overrides the stray shell value');
    expectTargetRejected(localEnv({ E2E_SUPABASE_URL: process.env.E2E_SUPABASE_URL }), 'a production URL loaded by the real dotenv', /PRODUCTION/);
  });
});

test('C2v3 CONTROL F12 without override, the stray shell value would silently win over the env file', async () => {
  const { mod, done } = await importGuardMutant([['dotenvConfig({ path: file, override: true });', 'dotenvConfig({ path: file, override: false });']]);
  try {
    withEnvFile(`E2E_SUPABASE_URL=${PRODUCTION_URL}\n`, () => {
      mod.loadE2EEnvFile(realDotenv.config);
      assert.equal(process.env.E2E_SUPABASE_URL, LOCAL_API, 'the control must observe the file being ignored');
    });
  } finally {
    done();
  }
});

// ---------------- F12: controls for rules that had none ----------------
test('C2v3 CONTROL the port rule is load-bearing', async () => {
  await controlV2('port', [['if (!rule.ports.includes(port)) fail(', 'if (false) fail(']], localEnv({ ...allUrls('http://127.0.0.1:54399') }));
});

test('C2v3 CONTROL the scheme rule is load-bearing', async () => {
  await controlV2('scheme', [['if (!rule.protocols.includes(parsed.protocol)) fail(', 'if (false) fail(']], localEnv({ ...allUrls('https://127.0.0.1:54321') }));
});

test('C2v3 CONTROL the user-info rules (parsed and literal) are load-bearing together; each alone rejects', async () => {
  const env = localEnv({ ...allUrls('http://u:p@127.0.0.1:54321') });
  const PARSED: Mutation = ['if ((parsed.username || parsed.password) && !rule.allowUserInfo) fail(', 'if (false) fail('];
  const LITERAL: Mutation = ["if (authority.includes('@') && !rule.allowUserInfo) fail(", 'if (false) fail('];
  assert.equal(await mutantResolveWith([PARSED], env), 'rejected');
  assert.equal(await mutantResolveWith([LITERAL], env), 'rejected');
  await controlV2('user-info', [PARSED, LITERAL], env);
});

test('C2v3 CONTROL the base-URL denial is load-bearing (hosted mode)', async () => {
  await controlV2('base URL', [['assertNotDeniedProject(mode, BASE_URL_VARIABLE, baseUrl);', '']], hostedEnv({ AUTH_E2E_BASE_URL: `https://${PROD_REF}.supabase.co` }));
});

test('C2v3 CONTROL the AUTH_E2E_EXPECTED_PROJECT_REF refusal in local mode is load-bearing', async () => {
  await controlV2('expected ref', [['if (env.AUTH_E2E_EXPECTED_PROJECT_REF !== undefined) {', 'if (false) {']], localEnv({ AUTH_E2E_EXPECTED_PROJECT_REF: E2E_REF }));
});

// ---------------- v3 controls for the new rules ----------------
test('C2v3 CONTROL F4 the production Redis host denial is load-bearing', async () => {
  await controlV2('prod redis', [['for (const host of PRODUCTION_REDIS_HOSTNAMES) {', 'for (const host of [] as string[]) {']], hostedEnv({ REDIS_URL: PROD_REDIS }));
});

test('C2v3 CONTROL F4 the hosted denial of unknown connection variables is load-bearing', async () => {
  await controlV2('unknown var denial', [['for (const name of connectionLike) if (!known.has(name)) assertNotDeniedProject(', 'for (const name of [] as string[]) if (!known.has(name)) assertNotDeniedProject(']], hostedEnv({ SOME_OTHER_REDIS_URL: PROD_REDIS }));
});

test('C2v3 CONTROL F4 the unknown-variable refusal in local mode is load-bearing', async () => {
  await controlV2('unknown var', [["if (!known.has(name)) fail(mode, name, 'is an unrecognised", "if (false) fail(mode, name, 'is an unrecognised"]], localEnv({ ANALYTICS_REDIS_URL: 'redis://127.0.0.1:6379' }));
});

test('C2v3 CONTROL F4 the required REDIS_URL is load-bearing', async () => {
  await controlV2('REDIS_URL required', [["if (!redisInputs.some((i) => i.name === 'REDIS_URL')) fail(", 'if (false) fail(']], localEnv({ REDIS_URL: undefined }));
});

test('C2v3 CONTROL F4/F15 the enumerated override refusal covers the new variables', async () => {
  await controlV2('GROUNDING_STORE_DSN', [['for (const input of overrideInputs) fail(', 'for (const input of []) fail(']], localEnv({ GROUNDING_STORE_DSN: `postgresql://postgres:${LOCAL_DB_PASSWORD}@127.0.0.1:54322/postgres` }));
});

test('C2v3 CONTROL F15 the PG* refusal and the unknown-variable refusal each reject; both removed, PGHOSTADDR passes', async () => {
  const env = localEnv({ PGHOSTADDR: '203.0.113.7' });
  const LIBPQ: Mutation = ['if (LIBPQ_NAME_PATTERN.test(name)) fail(', 'if (false) fail('];
  const UNKNOWN: Mutation = ["if (!known.has(name)) fail(mode, name, 'is an unrecognised", "if (false) fail(mode, name, 'is an unrecognised"];
  assert.equal(await mutantResolveWith([LIBPQ], env), 'rejected');
  assert.equal(await mutantResolveWith([UNKNOWN], env), 'rejected');
  await controlV2('PGHOSTADDR', [LIBPQ, UNKNOWN], env);
});

test('C2v3 CONTROL F5 the local "ref" claim refusal is load-bearing', async () => {
  await controlV2('ref claim', [['if (claims.ref !== undefined) fail(', 'if (false) fail(']], localEnv(keyEnv(jwt({ iss: 'supabase-demo', ref: 'abcdefghijklmnopqrst', role: 'service_role' }))));
});

test('C2v3 CONTROL F5 the local issuer check is load-bearing', async () => {
  await controlV2('iss claim', [["if (claims.iss !== 'supabase-demo') fail(", 'if (false) fail(']], localEnv(keyEnv(jwt({ iss: 'supabase', role: 'service_role' }))));
});

test('C2v3 CONTROL F5 the hosted project-binding check is load-bearing', async () => {
  await controlV2('hosted ref', [['} else if (ref !== null && hostedProjectRef !== null && ref !== hostedProjectRef) {', '} else if (false) {']], hostedEnv({ E2E_SUPABASE_SECRET_KEY: OTHER_PROJECT_JWT }));
});

test('C2v3 CONTROL F5 the unreadable-payload refusal is load-bearing', async () => {
  await controlV2('unreadable JWT', [["if (Object.keys(claims).length === 0) fail(", 'if (false) fail(']], hostedEnv({ E2E_SUPABASE_SECRET_KEY: 'aaaa.bbbb.cccc' }));
});

test('C2v3 CONTROL F8 the strict character check is load-bearing (tab smuggled into the API URL)', async () => {
  await controlV2('tab', [[STRICT_TEXT_CHECK, 'if (false) fail(']], localEnv({ ...allUrls('http://127.0.0.1:54321\t') }));
});

test('C2v3 CONTROL F8 the single-"@" rule is load-bearing (libpq first-@ vs WHATWG last-@)', async () => {
  await controlV2('two @', [["if (raw.split('@').length > 2) fail(", 'if (false) fail(']], localEnv({ SUPABASE_DB_URL: 'postgresql://a@evil.example:5432@127.0.0.1:54322/postgres' }));
});

// =============================================================================
// C2 v3.1: independent delta review items R3, R4, R7, R8, R9 (each with a control).
// =============================================================================
test('C2v3.1 R4 a Request-like object whose toString differs from .url is refused before any request', async () => {
  const servers = await redirectServers();
  try {
    const target = resolveAuthE2ETarget(localEnv());
    const other = `http://127.0.0.1:${servers.portA}/obj`;
    const sneaky = { url: `${LOCAL_API}/auth/v1/admin/users`, toString: () => other };
    const guarded = createGuardedAdminFetch(target, (input, init) => fetch(input, init));
    await assert.rejects(() => guarded(sneaky as unknown as Request), /unsupported request input/);
    // a real Request is validated on the URL it will actually use
    await assert.rejects(() => guarded(new Request(other)), /not the validated Supabase origin/);
  } finally {
    await servers.close();
  }
});

test('C2v3.1 CONTROL R4 validating .url but sending another interpretation DOES reach the other origin', async () => {
  const { mod, done } = await importGuardMutant([
    ["    if (!(typeof input === 'string' || input instanceof URL || input instanceof Request)) {", '    if (false) {'],
    ['    if (new URL(request.url).origin !== allowedOrigin) {', '    if (new URL((input as { url?: string }).url ?? request.url).origin !== allowedOrigin) {'],
  ]);
  let reached = 0;
  const b = http.createServer((_req, res) => { reached += 1; res.end('{}'); });
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', r));
  try {
    const port = (b.address() as AddressInfo).port;
    const target = mod.resolveAuthE2ETarget(localEnv());
    const sneaky = { url: `${LOCAL_API}/auth/v1/admin/users`, toString: () => `http://127.0.0.1:${port}/obj` };
    await mod.createGuardedAdminFetch(target, (input: Request) => fetch(input))(sneaky).catch(() => undefined);
    assert.equal(reached, 1, 'the control must observe the request reaching the other origin');
  } finally {
    await new Promise((r) => b.close(r));
    done();
  }
});

test('C2v3.1 R7 an empty AUTH_E2E_EXPECTED_PROJECT_REF cannot switch the hosted allowlist off', () => {
  const other = 'https://abcdefghijabcdefghij.supabase.co';
  expectTargetRejected(hostedEnv({ ...allUrls(other), AUTH_E2E_EXPECTED_PROJECT_REF: '' }), 'empty expected ref with another project (the reviewer\'s input)', /AUTH_E2E_EXPECTED_PROJECT_REF/);
  expectTargetRejected(hostedEnv({ AUTH_E2E_EXPECTED_PROJECT_REF: '' }), 'empty expected ref with the E2E project', /AUTH_E2E_EXPECTED_PROJECT_REF/);
  assert.equal(resolveAuthE2ETarget(hostedEnv({ AUTH_E2E_EXPECTED_PROJECT_REF: E2E_REF })).mode, 'hosted');
});

test('C2v3.1 CONTROL R7 the empty-expected-ref refusal is load-bearing', async () => {
  await controlV2('empty expected ref', [["if (typeof env.AUTH_E2E_EXPECTED_PROJECT_REF === 'string' && env.AUTH_E2E_EXPECTED_PROJECT_REF.trim() === '') {", 'if (false) {']], hostedEnv({ ...allUrls('https://abcdefghijabcdefghij.supabase.co'), AUTH_E2E_EXPECTED_PROJECT_REF: '' }));
});

test('C2v3.1 R8 non-string "ref" claims and standard/padded base64 JWTs are inspected, not waved through', () => {
  const std = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
  const paddedProd = `${std({ alg: 'HS256' })}.${std({ iss: 'supabase', ref: PROD_REF, role: 'service_role' })}.sig`;
  const arrayRef = jwt({ iss: 'supabase', ref: ['abcdefghijklmnopqrst'], role: 'service_role' });
  expectRejectedWithout(hostedEnv({ E2E_SUPABASE_SECRET_KEY: paddedProd }), 'a standard-base64 production JWT (hosted)', paddedProd);
  expectRejectedWithout(hostedEnv({ E2E_SUPABASE_SECRET_KEY: arrayRef }), 'a non-string ref claim (hosted)', arrayRef, /not a string/);
  expectRejectedWithout(localEnv(keyEnv('abc.d!e.f')), 'a JWT-shaped key with an invalid payload alphabet', 'abc.d!e', /not a readable claims object/);
});

test('C2v3.1 CONTROL R8 the non-string ref refusal is load-bearing', async () => {
  await controlV2('array ref', [["if (claims.ref !== undefined && typeof claims.ref !== 'string') fail(", 'if (false) fail(']], hostedEnv({ E2E_SUPABASE_SECRET_KEY: jwt({ iss: 'supabase', ref: ['abcdefghijklmnopqrst'], role: 'service_role' }) }));
});

test('C2v3.1 R9 settings the app reads as limits or switches are not mistaken for connections', () => {
  const settings: Env = { REDIS_MAX_BYTES: '1000', REDIS_OVERFLOW_CAP_PER_QUEUE: '5', REDIS_USAGE_MAX_PLAUSIBLE_CMDS_PER_SEC: '50', ENTERPRISE_GOVERNANCE_REDIS_ENABLED: 'false', VARIANT_DIAGNOSTICS_REDIS_ENABLED: 'false' };
  assert.equal(resolveAuthE2ETarget(localEnv(settings)).mode, 'local');
  // connection-shaped test-only names stay refused
  expectTargetRejected(localEnv({ QUEUE_TOPOLOGY_INTEGRATION_REDIS_URL: 'redis://127.0.0.1:6379' }), 'an integration Redis URL', /unrecognised connection variable/);
});
