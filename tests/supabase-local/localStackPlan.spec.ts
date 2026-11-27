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
  BASELINE_GAP_MANIFEST,
  parseBaselineGapManifest,
  planReplay,
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

// ---------------- Baseline-gap manifest (same rules as real-schema-ci.sh step 3b) ----------------
const GAP_LEDGER = '20260916000000';
const GAP_FILES = ['20260101000000_gap_a.sql', '20260916000000_gap_at_max.sql', '20260917000000_after.sql', '20261001000000_later.sql'];
const gapExists = (name: string): boolean => GAP_FILES.includes(name);
const parseGaps = (text: string | null): string[] => parseBaselineGapManifest(text, GAP_LEDGER, gapExists);
const gapRefusal = (text: string, why: RegExp): void => {
  assert.ok(text.trim() !== '', 'scenario must contain an entry');
  assert.throws(() => parseGaps(text), (e: unknown) => e instanceof LocalStackPlanError && why.test((e as Error).message), `expected ${why} for ${JSON.stringify(text)}`);
};

test('GAP a valid manifest yields its entries in manifest order (comments, CRLF, padding and a missing final newline tolerated)', () => {
  const text = '# header\r\n\r\n  20260916000000_gap_at_max.sql  # at ledgerMax is allowed\r\n\t20260101000000_gap_a.sql';
  assert.deepEqual(parseGaps(text), ['20260916000000_gap_at_max.sql', '20260101000000_gap_a.sql']);
});

test('GAP an empty manifest (comments and blank lines only) and a missing manifest both mean no gaps', () => {
  assert.deepEqual(parseGaps('# only a comment\n\n   \n# 20260101000000_gap_a.sql\n'), []);
  assert.deepEqual(parseGaps(''), []);
  assert.deepEqual(parseGaps(null), []);
});

test('GAP a duplicate entry is refused', () => {
  assert.deepEqual(parseGaps('20260101000000_gap_a.sql\n'), ['20260101000000_gap_a.sql'], 'the single entry is valid');
  gapRefusal('20260101000000_gap_a.sql\n# again\n20260101000000_gap_a.sql\n', /listed twice/);
});

test('GAP an entry that is not a bare file name is refused (path, backslash, inner whitespace)', () => {
  gapRefusal('supabase/migrations/20260101000000_gap_a.sql\n', /bare migration file name/);
  gapRefusal('..\\20260101000000_gap_a.sql\n', /bare migration file name/);
  gapRefusal('20260101000000_gap a.sql\n', /bare migration file name/);
});

test('GAP an entry without .sql is refused', () => {
  gapRefusal('20260101000000_gap_a\n', /not a \.sql file name/);
  gapRefusal('20260101000000_gap_a.sql.bak\n', /not a \.sql file name/);
});

test('GAP an entry without a 14-digit version is refused', () => {
  gapRefusal('gap_a.sql\n', /no numeric version prefix/);
  gapRefusal('20260101000000.sql\n', /no numeric version prefix/);
  gapRefusal('2026010100000x_gap_a.sql\n', /no numeric version prefix/);
  gapRefusal('20260101_gap_a.sql\n', /14-digit version/);
  gapRefusal('202601010000000_gap_a.sql\n', /14-digit version/);
});

test('GAP an entry above ledgerMax is refused (the normal replay already applies it: no double apply)', () => {
  const normal = selectMigrations(GAP_FILES, GAP_LEDGER);
  assert.ok(normal.includes('20260917000000_after.sql'), 'scenario: the entry IS selected by the normal replay');
  gapRefusal('20260917000000_after.sql\n', /above ledgerMax/);
});

test('GAP an entry naming a file that does not exist is refused', () => {
  gapRefusal('20260102000000_missing.sql\n', /does not exist/);
});

test('GAP a malformed ledgerMax is refused even with no manifest', () => {
  assert.throws(() => parseBaselineGapManifest(null, '2026', gapExists), LocalStackPlanError);
});

test('GAP replay order: every migration above ledgerMax first, then the gaps in manifest order, each exactly once', () => {
  const plan = planReplay([...GAP_FILES, 'README.md'], GAP_LEDGER, '20260916000000_gap_at_max.sql\n20260101000000_gap_a.sql\n', gapExists);
  assert.deepEqual(plan.aboveLedgerMax, ['20260917000000_after.sql', '20261001000000_later.sql']);
  assert.deepEqual(plan.baselineGaps, ['20260916000000_gap_at_max.sql', '20260101000000_gap_a.sql']);
  assert.deepEqual(plan.ordered, ['20260917000000_after.sql', '20261001000000_later.sql', '20260916000000_gap_at_max.sql', '20260101000000_gap_a.sql']);
  assert.equal(new Set(plan.ordered).size, plan.ordered.length);
  assert.deepEqual(planReplay(GAP_FILES, GAP_LEDGER, null, gapExists).ordered, selectMigrations(GAP_FILES, GAP_LEDGER), 'no manifest: unchanged plan');
});

test('GAP the repository manifest is valid and puts content_learning_performance after every migration above ledgerMax', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase', '_schema', 'baseline.json'), 'utf8'));
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const manifest = fs.readFileSync(path.join(ROOT, BASELINE_GAP_MANIFEST), 'utf8');
  const plan = planReplay(fs.readdirSync(dir), String(meta.ledgerMax), manifest, (n) => fs.existsSync(path.join(dir, n)));
  assert.deepEqual(plan.baselineGaps, ['20260718000003_content_learning_performance.sql']);
  assert.deepEqual(plan.ordered.slice(0, plan.aboveLedgerMax.length), plan.aboveLedgerMax);
  assert.equal(plan.ordered[plan.ordered.length - 1], '20260718000003_content_learning_performance.sql');
  assert.equal(plan.ordered.length, plan.aboveLedgerMax.length + 1);
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

// ---------------- Review B2: restore classification (unit) ----------------
import { redactConnectionText } from './localStackPlan';

test('C1 B2 only a plain "ERROR: ... already exists" is tolerated; FATAL, PANIC and connection loss are not', () => {
  const ok = classifyRestoreErrors('psql:b.sql:9: ERROR:  relation "a" already exists\nNOTICE:  something\n');
  assert.deepEqual(ok, { total: 1, unexpected: [] });
  for (const line of [
    'psql:b.sql:10: FATAL:  terminating connection due to administrator command',
    'FATAL:  the database system is shutting down',
    'PANIC:  could not write to file "pg_wal/xlogtemp.1"',
    'server closed the connection unexpectedly',
    'psql: error: connection to server at "127.0.0.1", port 54322 failed: Connection refused',
    'connection to server was lost',
    'no connection to the server',
    'could not receive data from server: Connection reset by peer',
    'SSL SYSCALL error: EOF detected',
    'lost synchronization with server: got message type "x"',
    'FATAL:  role "x" already exists',
    'psql:b.sql:77: ERROR:  function public.f() does not exist',
  ]) {
    const r = classifyRestoreErrors(`psql:b.sql:9: ERROR:  relation "a" already exists\n${line}\n`);
    assert.equal(r.unexpected.length, 1, `must be unexpected: ${line}`);
    assert.equal(r.unexpected[0], line);
  }
  assert.deepEqual(classifyRestoreErrors(''), { total: 0, unexpected: [] });
});

test('C1 B2 restore diagnostics are shown without URL credentials', () => {
  assert.equal(
    redactConnectionText('FATAL: via postgresql://postgres:secret-pw@127.0.0.1:54322/postgres failed'),
    'FATAL: via postgresql://[REDACTED]@127.0.0.1:54322/postgres failed',
  );
  assert.equal(redactConnectionText('plain line'), 'plain line');
});
