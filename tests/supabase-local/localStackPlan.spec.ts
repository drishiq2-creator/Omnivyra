import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HOSTED_SUPABASE_VARIABLES,
  LocalStackPlanError,
  PINNED_SUPABASE_CLI_VERSION,
  assertGitHubHostedRunner,
  assertNoHostedSupabaseEnv,
  buildAuthSuiteEnv,
  classifyRestoreErrors,
  parseStatusEnv,
  readStackConfig,
  repoRootFrom,
  selectMigrations,
} from './localStackPlan';
import { E2EEnvironmentError } from '../auth/e2eEnvironmentGuard';

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG = fs.readFileSync(path.join(__dirname, 'supabase', 'config.toml'), 'utf8');

test('C1 config.toml: project_id and ports are read and match the guard', () => {
  const cfg = readStackConfig(CONFIG);
  assert.equal(cfg.projectId, 'omnivyra-auth-e2e-local');
  assert.equal(cfg.apiPort, 54321);
  assert.equal(cfg.dbPort, 54322);
});

test('C1 config.toml: a port drift from the guard is refused', () => {
  assert.throws(() => readStackConfig(CONFIG.replace('port = 54321', 'port = 64321')), LocalStackPlanError);
});

test('C1 config.toml contains no hosted project reference, no secret-looking value and no absolute path', () => {
  for (const bad of ['klkiseupptzbecbxwrky', 'lomndxmrpyudaegddpef', 'supabase.co', 'sb_secret_', 'sbp_', 'eyJ', 'C:\\', '/home/', '/Users/']) {
    assert.ok(!CONFIG.includes(bad), `config.toml must not contain "${bad}"`);
  }
});

test('C1 the repository-root supabase/ folder still has no config.toml (one consistent structure)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'supabase', 'config.toml')));
});

test('C1 repository identity is verified from package.json', () => {
  assert.equal(repoRootFrom(__dirname), ROOT);
});

test('C1 runner gate: only a GitHub-hosted CI runner is accepted', () => {
  const ok = { GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ID: '1' };
  assertGitHubHostedRunner(ok);
  for (const bad of [{}, { ...ok, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...ok, GITHUB_ACTIONS: undefined }, { ...ok, CI: 'false' }, { ...ok, GITHUB_RUN_ID: '' }]) {
    assert.throws(() => assertGitHubHostedRunner(bad), LocalStackPlanError);
  }
});

test('C1 hosted-Supabase variables and hosted link files are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supabase-local-wd-'));
  try {
    assertNoHostedSupabaseEnv({}, dir);
    for (const name of HOSTED_SUPABASE_VARIABLES) {
      assert.throws(() => assertNoHostedSupabaseEnv({ [name]: 'value-not-shown' }, dir), (e: unknown) => e instanceof LocalStackPlanError && !(e as Error).message.includes('value-not-shown'));
    }
    fs.mkdirSync(path.join(dir, 'supabase', '.temp'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'supabase', '.temp', 'project-ref'), 'x');
    assert.throws(() => assertNoHostedSupabaseEnv({}, dir), LocalStackPlanError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C1 migration selection matches real-schema-ci (14-digit versions above ledgerMax, sorted)', () => {
  const files = ['20260101_legacy.sql', '20260916000000_at_max.sql', '20260916000001_after.sql', '20270101000000_b.sql', '20261001000000_a.sql', 'README.md', '2026091600000x_bad.sql'];
  assert.deepEqual(selectMigrations(files, '20260916000000'), ['20260916000001_after.sql', '20261001000000_a.sql', '20270101000000_b.sql']);
  assert.throws(() => selectMigrations(files, '2026'), LocalStackPlanError);
});

test('C1 migration selection on the real repository is non-empty and every selected file exists', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase', '_schema', 'baseline.json'), 'utf8'));
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const selected = selectMigrations(fs.readdirSync(dir), String(meta.ledgerMax));
  assert.ok(selected.length > 0);
  for (const f of selected) assert.ok(fs.existsSync(path.join(dir, f)));
});

test('C1 restore classification tolerates only "already exists"', () => {
  assert.deepEqual(classifyRestoreErrors('psql:x: ERROR:  schema "public" already exists\nnotice'), { total: 1, unexpected: [] });
  const r = classifyRestoreErrors('ERROR:  relation "a" already exists\nERROR:  function x() does not exist');
  assert.equal(r.total, 2);
  assert.equal(r.unexpected.length, 1);
});

const STATUS = [
  'API_URL="http://127.0.0.1:54321"',
  'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
  'ANON_KEY="local-anon-key-for-tests"',
  'SERVICE_ROLE_KEY="local-service-role-key-for-tests"',
  'PUBLISHABLE_KEY="sb_publishable_local_test"',
  'SECRET_KEY="local-secret-key-for-tests"',
].join('\n');

test('C1 status export: produces the auth-suite env and the REAL guard accepts it in local mode', () => {
  const env = buildAuthSuiteEnv(parseStatusEnv(STATUS));
  assert.equal(env.AUTH_E2E_TARGET, 'local');
  assert.equal(env.E2E_SUPABASE_URL, 'http://127.0.0.1:54321');
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL);
  assert.equal(env.E2E_SUPABASE_SECRET_KEY, 'local-secret-key-for-tests');
  assert.equal(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_local_test');
  assert.ok(!('DB_URL' in env), 'the database URL is not exported to the app or the tests');
});

test('C1 status export: a hosted or non-loopback endpoint is refused (no fallback)', () => {
  for (const [k, v] of [
    ['API_URL', 'https://klkiseupptzbecbxwrky.supabase.co'],
    ['API_URL', 'https://lomndxmrpyudaegddpef.supabase.co'],
    ['API_URL', 'http://10.1.2.3:54321'],
    ['API_URL', 'http://127.0.0.1:8000'],
    ['DB_URL', 'postgresql://postgres:postgres@db.klkiseupptzbecbxwrky.supabase.co:5432/postgres'],
    ['DB_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/postgres'],
  ]) {
    const status = parseStatusEnv(STATUS);
    status[k] = v;
    assert.throws(() => buildAuthSuiteEnv(status), (e: unknown) => e instanceof E2EEnvironmentError || e instanceof LocalStackPlanError, `${k}=${v} must be refused`);
  }
  const missing = parseStatusEnv(STATUS);
  delete missing.API_URL;
  assert.throws(() => buildAuthSuiteEnv(missing), LocalStackPlanError);
});

test('C1 bootstrap.sh: pinned CLI version, runner gate, no hosted commands, no schema-bootstrap.sql, cleanup scoped', () => {
  const sh = fs.readFileSync(path.join(__dirname, 'bootstrap.sh'), 'utf8');
  assert.ok(sh.includes(`PINNED_CLI="${PINNED_SUPABASE_CLI_VERSION}"`), 'shell and TS pin the same CLI version');
  assert.ok(sh.includes('"${PLAN[@]}" check-ci') && sh.includes('"${PLAN[@]}" check-env'), 'up/down run the runner and hosted-env gates');
  for (const forbidden of ['--linked', 'db push', 'db pull', 'migration up', 'migration repair', 'supabase link', '--project-ref', 'schema-bootstrap.sql', 'klkiseupptzbecbxwrky', 'lomndxmrpyudaegddpef']) {
    assert.ok(!sh.replace(/^#.*$/gm, '').includes(forbidden), `bootstrap.sh must not use "${forbidden}"`);
  }
  assert.ok(sh.includes('supabase stop --workdir "$WORKDIR" --no-backup'), 'cleanup stops only this workdir\'s stack');
  assert.ok(/supabase start --workdir "\$WORKDIR"/.test(sh));
  const leaking = sh
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .filter((line) => /\b(echo|printf)\b/.test(line) && /\$\{?(SECRET|DB_URL|line)\b/.test(line) && !line.includes('::add-mask::'));
  assert.deepEqual(leaking, [], 'secrets are never echoed except as GitHub masks');
  assert.ok(!sh.includes('\r'), 'LF line endings');
});

test('C1 stack-extensions.sql only creates extensions (no auth.* function, role or table)', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'stack-extensions.sql'), 'utf8').replace(/^--.*$/gm, '');
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 5);
  for (const s of statements) assert.match(s, /^CREATE EXTENSION IF NOT EXISTS \S+ WITH SCHEMA extensions$/);
});

// ---------------- v3.1 (independent delta review R3) ----------------
import { buildStackEndpoints } from './localStackPlan';

const R3_STATUS = {
  API_URL: 'http://127.0.0.1:54321',
  DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SECRET_KEY: 'local-stack-secret-for-plan-tests-only',
  PUBLISHABLE_KEY: 'local-stack-publishable-for-plan-tests',
};
// libpq splits user-info at the FIRST "@" and accepts a host list; WHATWG reads host 127.0.0.1:54322.
const R3_DB_URL = 'postgresql://u@evil.example:5432,x@127.0.0.1:54322/postgres';

test('C1 v3.1 R3 the bootstrap DB/API URLs get the strict raw-text rule (the reviewer\'s multi-host input is refused)', () => {
  assert.deepEqual(buildStackEndpoints(R3_STATUS), { STACK_API_URL: R3_STATUS.API_URL, STACK_DB_URL: R3_STATUS.DB_URL });
  assert.throws(() => buildStackEndpoints({ ...R3_STATUS, DB_URL: R3_DB_URL }), /DB_URL/);
  assert.throws(() => buildStackEndpoints({ ...R3_STATUS, API_URL: 'http://127.0.0.1:54321\t' }), /API_URL/);
});

test('C1 v3.1 CONTROL R3 without the strict rule, the multi-host DB URL is ACCEPTED', async () => {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const source = fsMod.readFileSync(pathMod.join(__dirname, 'localStackPlan.ts'), 'utf8');
  const marker = "  assertStrictLocalText('DB_URL', dbUrl);\n";
  assert.equal(source.split(marker).length - 1, 1);
  const dir = fsMod.mkdtempSync(pathMod.join(__dirname, '.mutant-plan-r3-'));
  const file = pathMod.join(dir, 'localStackPlan.ts');
  const guardUrl = pathToFileURL(pathMod.join(__dirname, '..', 'auth', 'e2eEnvironmentGuard.ts')).href;
  fsMod.writeFileSync(file, source.replace(marker, '').replace("from '../auth/e2eEnvironmentGuard'", `from ${JSON.stringify(guardUrl)}`));
  try {
    const mutant = await import(pathToFileURL(file).href);
    assert.equal(mutant.buildStackEndpoints({ ...R3_STATUS, DB_URL: R3_DB_URL }).STACK_DB_URL, R3_DB_URL, 'the control must observe acceptance');
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
});
