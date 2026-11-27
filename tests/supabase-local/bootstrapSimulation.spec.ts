/**
 * Hermetic simulation of tests/supabase-local/bootstrap.sh (v3 of C2/C3; review findings F6, F7, F8,
 * F15 and the bootstrap-correctness part of F12).
 *
 * NOTHING real is started. The script runs inside a throw-away copy of the repository layout with
 * STUB `supabase`, `psql`, `docker` and `curl` executables first on PATH, the REAL localStackPlan.ts
 * and e2eEnvironmentGuard.ts, and DOCKER_HOST pointed at a closed port. Before every run the test
 * proves that each of those four tools resolves to its stub; otherwise it fails without running the
 * script. Only the GitHub-runner gate (`check-ci`) is answered by the wrapper: the real gate is
 * covered by localStackPlan.spec.ts and refuses everywhere but a GitHub-hosted runner.
 *
 * Each correction has a failing control: the same scenario against a scratch copy with the rule
 * removed must flip the observable outcome.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO = path.resolve(__dirname, '..', '..');
const REAL_TSX_CLI = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SIM_SECRET = 'sim-local-secret-key-value-0001';
const START_CREDENTIAL = 'SIM-START-CREDENTIAL-0001';
const START_DB_PASSWORD = 'sim-start-db-password';

/** Git for Windows root (holds usr/bin/bash.exe); only used on Windows. */
function findGitRoot(): string {
  const roots = [
    process.env.SIM_GIT_ROOT,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git'),
  ].filter((r): r is string => !!r);
  const found = roots.find((r) => fs.existsSync(path.join(r, 'usr', 'bin', 'bash.exe')));
  assert.ok(found, `Git Bash is required on Windows to simulate bootstrap.sh (looked in ${roots.join(', ')})`);
  return found as string;
}
const GIT_ROOT = process.platform === 'win32' ? findGitRoot() : '';
const BASH = process.platform === 'win32' ? path.join(GIT_ROOT, 'usr', 'bin', 'bash.exe') : '/bin/bash';

const DEFAULT_STATUS = [
  'API_URL="http://127.0.0.1:54321"',
  'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
  `SECRET_KEY="${SIM_SECRET}"`,
  'PUBLISHABLE_KEY="sim-publishable-key-0001"',
].join('\n');

type Mutation = readonly [file: string, marker: string, replacement: string];

type Sim = { root: string; bin: string; log: string; tmp: string };

function writeExec(file: string, body: string): void {
  fs.writeFileSync(file, body.replace(/\r\n/g, '\n'), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeSandbox(mutations: readonly Mutation[] = []): Sim {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-sim-'));
  const bin = path.join(root, 'stub-bin');
  const tmp = path.join(root, 'runner-temp');
  const log = path.join(root, 'calls.log');
  for (const d of ['stub-bin', 'runner-temp', 'supabase/_schema', 'supabase/migrations', 'tests/supabase-local/supabase', 'tests/auth', 'scripts/lib', 'node_modules/tsx/dist']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'omnivyra-admin-ui', private: true }));
  fs.writeFileSync(path.join(root, 'supabase/_schema/baseline.json'), JSON.stringify({ ledgerMax: '20260916000000', tables: 823 }));
  fs.writeFileSync(path.join(root, 'supabase/_schema/baseline.sql'), '-- simulated baseline\n');
  for (const m of ['20260101000000_before_ledger.sql', '20260917000000_sim_a.sql', '20260918000000_sim_b.sql']) {
    fs.writeFileSync(path.join(root, 'supabase/migrations', m), '-- simulated\n');
  }
  const copies: Record<string, string> = {
    'tests/supabase-local/bootstrap.sh': 'tests/supabase-local/bootstrap.sh',
    'tests/supabase-local/localStackPlan.ts': 'tests/supabase-local/localStackPlan.ts',
    'tests/supabase-local/stack-extensions.sql': 'tests/supabase-local/stack-extensions.sql',
    'tests/supabase-local/supabase/config.toml': 'tests/supabase-local/supabase/config.toml',
    'tests/auth/e2eEnvironmentGuard.ts': 'tests/auth/e2eEnvironmentGuard.ts',
    // round 26 / C3: the guard requires the shared Redis rule by relative path.
    'scripts/lib/e2eRedisIdentityRule.cjs': 'scripts/lib/e2eRedisIdentityRule.cjs',
  };
  for (const [to, from] of Object.entries(copies)) {
    let text = fs.readFileSync(path.join(REPO, from), 'utf8');
    for (const [file, marker, replacement] of mutations) {
      if (file !== to) continue;
      assert.equal(text.split(marker).length - 1, 1, `mutation marker must occur exactly once in ${file}: ${marker}`);
      text = text.replace(marker, replacement);
    }
    fs.writeFileSync(path.join(root, to), text);
  }
  // tsx wrapper: answers only the runner gate; can fail one plan command on request; else the real tsx.
  fs.writeFileSync(
    path.join(root, 'node_modules/tsx/dist/cli.mjs'),
    [
      "import { pathToFileURL } from 'node:url';",
      'const cmd = process.argv[3];',
      "if (cmd === 'check-ci') process.exit(0);",
      'if (process.env.SIM_FAIL_PLAN_CMD && cmd === process.env.SIM_FAIL_PLAN_CMD) {',
      "  process.stdout.write('20260917000000_sim_a.sql\\n');",
      '  process.exit(3);',
      '}',
      `await import(pathToFileURL(${JSON.stringify(REAL_TSX_CLI)}).href);`,
      '',
    ].join('\n'),
  );
  const logLine = 'printf \'%s\\n\' "$*" >> "$SIM_LOG"';
  writeExec(path.join(bin, 'supabase'), [
    '#!/usr/bin/env bash',
    `printf 'supabase %s | SUPABASE_URL=%s | SUPABASE_SECRET_KEY=%s\\n' "$*" "\${SUPABASE_URL:+set}" "\${SUPABASE_SECRET_KEY:+set}" >> "$SIM_LOG"`,
    'case "$1" in',
    '  --version) echo 2.122.0 ;;',
    `  start) echo "service_role key: ${START_CREDENTIAL}"; echo "DB URL: postgresql://postgres:${START_DB_PASSWORD}@127.0.0.1:54322/postgres"; echo "Started (simulated)"; exit "\${SIM_START_EXIT:-0}" ;;`,
    '  status) cat "$SIM_STATUS_FILE" ;;',
    '  stop) echo stopped ;;',
    '  *) exit 9 ;;',
    'esac',
    '',
  ].join('\n'));
  // psql runs under `env -i` (that is the point of F15), so its log path and failure switch are baked
  // in as absolute paths instead of being read from the environment.
  const posix = (p: string) => p.replace(/\\/g, '/');
  writeExec(path.join(bin, 'psql'), [
    '#!/usr/bin/env bash',
    `LOG=${JSON.stringify(posix(log))}`,
    `FAIL_FILE="$(cat ${JSON.stringify(posix(path.join(root, 'psql-fail-file')))} 2>/dev/null)"`,
    `printf 'psql %s | canary=%s\\n' "$*" "\${SIM_CANARY:-absent}" >> "$LOG"`,
    // Baseline restore behaviour (review B2) is read from files: stderr text, exit status, table count.
    `CTL=${JSON.stringify(posix(root))}`,
    'for a in "$@"; do',
    '  if [[ "$a" == *baseline.sql ]]; then',
    '    [ -f "$CTL/restore-stderr" ] && cat "$CTL/restore-stderr" >&2',
    '    exit "$(cat "$CTL/restore-exit" 2>/dev/null || echo 0)"',
    '  fi',
    '  if [ "$a" = "-tAc" ]; then cat "$CTL/tables-count" 2>/dev/null || echo 900; exit 0; fi',
    'done',
    'for a in "$@"; do',
    '  if [ -n "$FAIL_FILE" ] && [[ "$a" == *"$FAIL_FILE" ]]; then echo "ERROR:  simulated migration failure" >&2; exit 3; fi',
    '  if [ "$a" = "-tAc" ]; then echo 900; exit 0; fi',
    'done',
    'exit 0',
    '',
  ].join('\n'));
  writeExec(path.join(bin, 'curl'), ['#!/usr/bin/env bash', `printf 'curl %s\\n' "$*" >> "$SIM_LOG"`, 'exit 0', ''].join('\n'));
  writeExec(path.join(bin, 'docker'), ['#!/usr/bin/env bash', logLine.replace('"$*"', '"docker $*"'), 'exit 0', ''].join('\n'));
  return { root, bin, log, tmp };
}

function simEnv(sim: Sim, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const nodeDir = path.dirname(process.execPath);
  const sep = process.platform === 'win32' ? ';' : ':';
  const system = process.platform === 'win32'
    ? [path.join(GIT_ROOT, 'usr', 'bin')]
    : ['/usr/bin', '/bin'];
  const statusFile = path.join(sim.root, 'status.txt');
  if (!fs.existsSync(statusFile)) fs.writeFileSync(statusFile, DEFAULT_STATUS + '\n');
  const env: NodeJS.ProcessEnv = {
    PATH: [sim.bin, nodeDir, ...system].join(sep),
    HOME: sim.tmp,
    RUNNER_TEMP: sim.tmp,
    TMPDIR: sim.tmp,
    DOCKER_HOST: 'tcp://127.0.0.1:9',
    SIM_LOG: sim.log,
    SIM_STATUS_FILE: statusFile,
    ...extra,
  };
  if (process.platform === 'win32') {
    for (const k of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec']) {
      if (process.env[k] && env[k] === undefined) env[k] = process.env[k];
    }
  }
  return env;
}

/** Refuses to run the script unless supabase, psql, docker and curl all resolve to the stubs. */
function assertStubsWin(sim: Sim, env: NodeJS.ProcessEnv): void {
  const r = spawnSync(BASH, ['-c', 'cd "$1" && stub="$(pwd -P)"; for t in supabase psql docker curl; do p="$(command -v "$t")" || { echo "MISSING $t"; continue; }; d="$(cd "$(dirname "$p")" && pwd -P)"; [ "$d" = "$stub" ] && echo "STUB $t" || echo "REAL $t $p"; done', 'x', sim.bin], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.deepEqual(lines, ['STUB supabase', 'STUB psql', 'STUB docker', 'STUB curl'], `refusing to simulate: a real tool would run:\n${r.stdout}`);
}

type Run = { status: number | null; out: string; calls: string[]; result: Record<string, unknown> | null };

function runBootstrap(sim: Sim, args: string[], extra: Record<string, string> = {}): Run {
  const env = simEnv(sim, extra);
  if (extra.SIM_PSQL_FAIL_FILE) fs.writeFileSync(path.join(sim.root, 'psql-fail-file'), extra.SIM_PSQL_FAIL_FILE);
  assertStubsWin(sim, env);
  const r = spawnSync(BASH, [path.join(sim.root, 'tests/supabase-local/bootstrap.sh'), ...args], { env, cwd: sim.root, encoding: 'utf8', timeout: 240_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /BOOTSTRAP_RESULT (\{.*\})/.exec(r.stdout);
  return { status: r.status, out, calls: fs.readFileSync(sim.log, 'utf8').split(/\r?\n/).filter(Boolean), result: m ? JSON.parse(m[1]) : null };
}

function withSandbox<T>(fn: (sim: Sim) => T, mutations: readonly Mutation[] = []): T {
  const sim = makeSandbox(mutations);
  try {
    return fn(sim);
  } finally {
    fs.rmSync(sim.root, { recursive: true, force: true });
  }
}

const migrationCalls = (calls: string[]): string[] => calls.filter((c) => c.startsWith('psql ') && /supabase[\\/]migrations[\\/]/.test(c));

test('SIM baseline: a healthy simulated stack completes with every planned migration, using only stubs', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.result?.status, 'ok');
    assert.equal(r.result?.stage, 'complete');
    assert.equal(r.result?.migrationsReplayed, 2, 'exactly the two migrations above ledgerMax');
    assert.equal(migrationCalls(r.calls).length, 2);
    assert.ok(r.calls.some((c) => c.startsWith('supabase start')), 'the stub CLI was used');
  });
});

test('SIM F6: supabase start credentials never reach the log, on success or on failure', () => {
  for (const startExit of ['0', '1']) {
    withSandbox((sim) => {
      const r = runBootstrap(sim, ['up'], { SIM_START_EXIT: startExit });
      for (const secret of [START_CREDENTIAL, START_DB_PASSWORD, SIM_SECRET]) {
        assert.ok(!r.out.includes(secret), `start exit ${startExit}: output leaked ${secret}`);
      }
      if (startExit === '1') {
        assert.notEqual(r.status, 0);
        assert.equal(r.result?.stage, 'start');
        assert.match(r.out, /Started \(simulated\)/, 'credential-free diagnostic lines are still shown');
      }
    });
  }
});

test('SIM F6 CONTROL: without the capture, the start credentials DO reach the log', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up']);
    assert.ok(r.out.includes(START_CREDENTIAL), 'the control must observe the leak');
  }, [['tests/supabase-local/bootstrap.sh', 'if ! run_supabase start --workdir "$WORKDIR" > "$RUN_DIR/start.log" 2>&1; then', 'if ! run_supabase start --workdir "$WORKDIR"; then']]);
});

const F7_LIST_BLOCK = `  "\${PLAN[@]}" migrations > "$RUN_DIR/migrations.txt" || fail "could not list the migrations to replay"`;
const F7_LOOP_END = `  done < "$RUN_DIR/migrations.txt"
  [ "$REPLAYED" = "$PLANNED_MIGRATIONS" ] || fail "replayed $REPLAYED of $PLANNED_MIGRATIONS planned migrations"`;
const F7_COUNT_CHECK = `  [ "$EXPECTED_MIGRATIONS" = "$PLANNED_MIGRATIONS" ] || fail "migration list has $EXPECTED_MIGRATIONS entries but the plan has $PLANNED_MIGRATIONS"`;

test('SIM F7: a failing migration-list producer stops the bootstrap (no partial replay)', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up'], { SIM_FAIL_PLAN_CMD: 'migrations' });
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.result?.status, 'failed');
    assert.equal(r.result?.stage, 'migration-replay');
    assert.equal(migrationCalls(r.calls).length, 0, 'no migration may be applied from a failed list');
  });
});

test('SIM F7 CONTROL: the previous process-substitution loop swallowed the failure and reported ok', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up'], { SIM_FAIL_PLAN_CMD: 'migrations' });
    assert.equal(r.status, 0, 'the old form must exit 0 here: that is the defect');
    assert.equal(r.result?.status, 'ok');
    assert.equal(r.result?.migrationsReplayed, 1, 'a partial replay was reported as success');
  }, [
    ['tests/supabase-local/bootstrap.sh', F7_LIST_BLOCK, '  :'],
    ['tests/supabase-local/bootstrap.sh', F7_COUNT_CHECK, '  :'],
    ['tests/supabase-local/bootstrap.sh', F7_LOOP_END, '  done < <("${PLAN[@]}" migrations)'],
  ]);
});

test('SIM F7: a failing migration-count producer or a short list also stops the bootstrap', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up'], { SIM_FAIL_PLAN_CMD: 'migration-count' });
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.result?.stage, 'migration-replay');
    assert.equal(migrationCalls(r.calls).length, 0);
  });
});

test('SIM: a migration that fails to apply fails the bootstrap at that migration', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up'], { SIM_PSQL_FAIL_FILE: '20260918000000_sim_b.sql' });
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.result?.status, 'failed');
    assert.equal(r.result?.stage, 'migration-replay');
    assert.equal(r.result?.migrationsReplayed, 1);
    assert.match(r.out, /migration 20260918000000_sim_b\.sql did not apply/);
  });
});

const DUPLICATE_STATUS = [
  'API_URL="http://127.0.0.1:54321"',
  'DB_URL="postgresql://postgres:postgres@db.attacker.example:5432/postgres"',
  'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
  `SECRET_KEY="${SIM_SECRET}"`,
  'PUBLISHABLE_KEY="sim-publishable-key-0001"',
].join('\n');

test('SIM F8: a duplicated status key is refused before any database connection', () => {
  withSandbox((sim) => {
    fs.writeFileSync(path.join(sim.root, 'status.txt'), DUPLICATE_STATUS + '\n');
    const r = runBootstrap(sim, ['up']);
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.result?.stage, 'status');
    assert.equal(r.calls.filter((c) => c.startsWith('psql ')).length, 0);
  });
});

test('SIM F8 CONTROL: with the old first-match reader and last-wins parser, psql connects to the UNVALIDATED host', () => {
  withSandbox((sim) => {
    fs.writeFileSync(path.join(sim.root, 'status.txt'), DUPLICATE_STATUS + '\n');
    const r = runBootstrap(sim, ['up']);
    assert.ok(r.calls.some((c) => c.startsWith('psql ') && c.includes('db.attacker.example')), `the control must observe the differential:\n${r.calls.join('\n')}`);
  }, [
    ['tests/supabase-local/localStackPlan.ts', 'if (Object.prototype.hasOwnProperty.call(out, m[1])) throw', 'if (false) throw'],
    ['tests/supabase-local/bootstrap.sh', 'DB_URL="$(read_validated STACK_DB_URL "$RUN_DIR/stack.env")"', 'DB_URL="$(grep -E "^DB_URL=" "$RUN_DIR/status.env" | head -1 | cut -d= -f2- | sed -e \'s/^"//\' -e \'s/"$//\')"'],
  ]);
});

test('SIM F8: psql and curl receive exactly the validated endpoint strings', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up']);
    assert.equal(r.status, 0, r.out);
    for (const c of r.calls.filter((x) => x.startsWith('psql '))) assert.ok(c.includes('postgresql://postgres:postgres@127.0.0.1:54322/postgres'), c);
    const curls = r.calls.filter((x) => x.startsWith('curl '));
    assert.ok(curls.length >= 2);
    for (const c of curls) assert.ok(c.includes('http://127.0.0.1:54321/'), c);
  });
});

test('SIM F15: psql runs with an empty environment (-X, no inherited variables); curl ignores proxies and redirects', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up'], { SIM_CANARY: 'inherited' });
    assert.equal(r.status, 0, r.out);
    const psqls = r.calls.filter((c) => c.startsWith('psql '));
    assert.ok(psqls.length > 0);
    for (const c of psqls) {
      assert.match(c, /^psql -X /, c);
      assert.match(c, /canary=absent$/, `psql inherited the caller environment: ${c}`);
    }
    for (const c of r.calls.filter((x) => x.startsWith('curl '))) {
      assert.match(c, /^curl -q --noproxy \* --proto =http --max-redirs 0 /, c);
    }
  });
});

test('SIM F15 CONTROL: without env -i, psql DOES inherit the caller environment', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up'], { SIM_CANARY: 'inherited' });
    assert.ok(r.calls.some((c) => c.startsWith('psql ') && c.endsWith('canary=inherited')), 'the control must observe inheritance');
  }, [['tests/supabase-local/bootstrap.sh', 'run_psql() { env -i PATH="$PATH" HOME="$RUN_DIR" LC_ALL=C psql -X "$@"; }', 'run_psql() { psql -X "$@"; }']]);
});

test('SIM F15: PG* and unknown SUPABASE_* variables are refused before the CLI starts anything', () => {
  for (const [name, value] of [['PGHOSTADDR', '203.0.113.7'], ['PGSERVICE', 'prod'], ['SUPABASE_AUTH_SITE_URL', 'https://evil.example'], ['SUPABASE_WORKDIR', '/elsewhere']]) {
    withSandbox((sim) => {
      const r = runBootstrap(sim, ['up'], { [name]: value });
      assert.notEqual(r.status, 0, `${name}: ${r.out}`);
      assert.equal(r.result?.stage, 'preflight', name);
      assert.ok(!r.calls.some((c) => c.startsWith('supabase start')), `${name}: the CLI must not start`);
      assert.ok(!r.out.includes(value), `${name}: the value must not be echoed`);
    });
  }
});

test('SIM F15: teardown strips the exported app variables from the CLI environment', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['down'], { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SECRET_KEY: SIM_SECRET, SUPABASE_CLI_VERSION: '2.122.0' });
    assert.equal(r.status, 0, r.out);
    const stop = r.calls.find((c) => c.startsWith('supabase stop'));
    assert.ok(stop, 'stop was called');
    assert.match(stop!, /SUPABASE_URL= \| SUPABASE_SECRET_KEY=$/, `the CLI saw app variables: ${stop}`);
  });
});

test('SIM R1 on GitHub the teed log carries ::add-mask:: values, and redact-logs removes them with NO secret env', () => {
  withSandbox((sim) => {
    const r = runBootstrap(sim, ['up'], { GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('::add-mask::') && r.out.includes(SIM_SECRET), 'realism: the masked key IS in the raw output, as in the CI artifact');
    const log = path.join(sim.root, 'bootstrap-up.log');
    fs.writeFileSync(log, r.out);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const red = spawnSync(process.execPath, [REAL_TSX_CLI, path.join(REPO, 'tests/supabase-local/ciAssertions.ts'), 'redact-logs', log], { env, encoding: 'utf8', cwd: REPO });
    assert.equal(red.status, 0, red.stderr);
    const after = fs.readFileSync(log, 'utf8');
    assert.ok(!after.includes(SIM_SECRET), 'the key must be gone');
    assert.ok(!after.includes('postgres:postgres@'), 'the DB URL user-info must be gone');
    assert.match(after, /BOOTSTRAP_RESULT \{"status":"ok"/, 'the result line is kept');
  });
});

// ---------------- Review B2: baseline restore failure detection ----------------
type Restore = { stderr?: string; exit?: number; tables?: string };

function writeRestoreControls(sim: Sim, r: Restore): void {
  if (r.stderr !== undefined) fs.writeFileSync(path.join(sim.root, 'restore-stderr'), r.stderr);
  if (r.exit !== undefined) fs.writeFileSync(path.join(sim.root, 'restore-exit'), String(r.exit));
  if (r.tables !== undefined) fs.writeFileSync(path.join(sim.root, 'tables-count'), r.tables);
}

/** Runs the REAL CI check on the bootstrap output; returns its exit status and whether it printed the success marker. */
function ciVerify(sim: Sim, out: string): { status: number | null; verified: boolean } {
  const log = path.join(sim.root, 'bootstrap-up.log');
  fs.writeFileSync(log, out);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const r = spawnSync(process.execPath, [REAL_TSX_CLI, path.join(REPO, 'tests/supabase-local/ciAssertions.ts'), 'assert-bootstrap-result', log, '2'], { env, encoding: 'utf8', cwd: REPO });
  return { status: r.status, verified: /BOOTSTRAP_VERIFIED/.test(`${r.stdout}${r.stderr}`) };
}

function restoreRun(r: Restore, mutations: readonly Mutation[] = []) {
  return withSandbox((sim) => {
    writeRestoreControls(sim, r);
    const run = runBootstrap(sim, ['up']);
    return { run, ci: ciVerify(sim, run.out) };
  }, mutations);
}

function assertRestoreFailed(why: string, x: ReturnType<typeof restoreRun>): void {
  assert.notEqual(x.run.status, 0, `${why}: the bootstrap must fail\n${x.run.out}`);
  assert.equal(x.run.result?.status, 'failed', why);
  assert.equal(x.run.result?.stage, 'baseline-restore', `${why}: must stop AT the restore stage`);
  assert.equal(migrationCalls(x.run.calls).length, 0, `${why}: no migration may run after a failed restore`);
  assert.ok(!x.run.calls.some((c) => c.startsWith('curl ')), `${why}: no health check may run after a failed restore`);
  assert.notEqual(x.ci.status, 0, `${why}: the CI check must refuse`);
  assert.equal(x.ci.verified, false, `${why}: BOOTSTRAP_VERIFIED must never be printed`);
}

const ALREADY_EXISTS = 'psql:/w/supabase/_schema/baseline.sql:12: ERROR:  relation "accounts" already exists\n';

test('SIM B2 a successful restore (with the tolerated "already exists") completes and is verified', () => {
  const x = restoreRun({ stderr: ALREADY_EXISTS, exit: 0, tables: '869' });
  assert.equal(x.run.status, 0, x.run.out);
  assert.equal(x.run.result?.stage, 'complete');
  assert.equal(x.ci.status, 0);
  assert.equal(x.ci.verified, true, 'the positive case must reach BOOTSTRAP_VERIFIED, otherwise the negatives prove nothing');
});

test('SIM B2 every incomplete restore fails at the restore stage, before replay and health, with no success marker', () => {
  const cases: Array<[string, Restore]> = [
    ['non-zero exit, empty stderr', { exit: 2, stderr: '' }],
    ['non-zero exit 1 (psql fatal)', { exit: 1, stderr: 'psql: error: out of memory\n' }],
    ['exit 0 with FATAL', { exit: 0, stderr: ALREADY_EXISTS + 'FATAL:  terminating connection due to administrator command\n' }],
    ['exit 0 with PANIC', { exit: 0, stderr: 'PANIC:  could not write to file "pg_wal/xlogtemp"\n' }],
    ['connection lost (exit 2)', { exit: 2, stderr: 'server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally\nconnection to server was lost\n' }],
    ['connection lost reported with exit 0', { exit: 0, stderr: 'psql:/w/baseline.sql:4100: server closed the connection unexpectedly\n' }],
    ['unexpected ERROR', { exit: 0, stderr: ALREADY_EXISTS + 'psql:/w/baseline.sql:77: ERROR:  function public.f() does not exist\n' }],
    ['"already exists" on a FATAL line is not tolerated', { exit: 0, stderr: 'FATAL:  database "postgres" already exists\n' }],
    ['partial restore: missing tables', { exit: 0, stderr: ALREADY_EXISTS, tables: '822' }],
    ['partial restore: unreadable table count', { exit: 0, stderr: '', tables: '' }],
  ];
  for (const [why, r] of cases) assertRestoreFailed(why, restoreRun(r));
});

test('SIM B2 restore diagnostics never print connection credentials', () => {
  const x = restoreRun({ exit: 0, stderr: 'FATAL:  could not connect using postgresql://postgres:leaked-db-pw@127.0.0.1:54322/postgres\n' });
  assertRestoreFailed('credential in a FATAL line', x);
  assert.ok(!x.run.out.includes('leaked-db-pw'), 'the diagnostic leaked the password');
  assert.match(x.run.out, /FATAL:  could not connect/, 'the diagnostic itself is still shown');
});

test('SIM B2 CONTROL without the exit-status check, a restore that exited 2 with no stderr is reported as success', () => {
  const x = restoreRun({ exit: 2, stderr: '' }, [['tests/supabase-local/bootstrap.sh', 'if [ "$RESTORE_EXIT" != "0" ]; then', 'if false; then']]);
  assert.equal(x.run.result?.status, 'ok', 'the control must observe the false success');
  assert.equal(x.ci.verified, true, 'and the CI check would have printed BOOTSTRAP_VERIFIED');
});

test('SIM B2 CONTROL with the previous ERROR-only classifier, a FATAL with exit 0 is reported as success', () => {
  const x = restoreRun({ exit: 0, stderr: 'FATAL:  terminating connection due to administrator command\n' }, [
    ['tests/supabase-local/localStackPlan.ts', "  const relevant = lines.filter((l) => /\\bERROR:/.test(l) || isFailure(l));", "  const relevant = lines.filter((l) => /\\bERROR:/.test(l));"],
  ]);
  assert.equal(x.run.result?.status, 'ok', 'the control must observe the false success');
});

test('SIM B2 CONTROL without the table-count check, a partial restore is reported as success', () => {
  const x = restoreRun({ exit: 0, stderr: '', tables: '822' }, [['tests/supabase-local/bootstrap.sh', '[ "$TABLES" -ge "$MIN_TABLES" ] || fail', 'true || fail']]);
  assert.equal(x.run.result?.status, 'ok', 'the control must observe the false success');
});

// ---------------- Baseline-gap manifest (real-schema-ci.sh step 3b) ----------------
const GAP_MANIFEST = 'supabase/_schema/baseline-gap-migrations.txt';
const GAP_ENTRY = '20260101000000_before_ledger.sql';
const PLAN_ORDERED = '  return { aboveLedgerMax, baselineGaps, ordered: [...aboveLedgerMax, ...baselineGaps] };';

function gapRun(manifest: string, extra: Record<string, string> = {}, mutations: readonly Mutation[] = []): Run {
  return withSandbox((sim) => {
    fs.writeFileSync(path.join(sim.root, GAP_MANIFEST), manifest);
    return runBootstrap(sim, ['up'], extra);
  }, mutations);
}
const appliedNames = (r: Run): string[] => migrationCalls(r.calls).map((c) => /supabase[\\/]migrations[\\/](\S+\.sql)/.exec(c)?.[1] ?? c);

test('SIM GAP a manifest entry is applied once, AFTER every migration above ledgerMax, and counted', () => {
  const r = gapRun(`# gap\n${GAP_ENTRY}\n`);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.result?.stage, 'complete');
  assert.equal(r.result?.migrationsReplayed, 3);
  assert.deepEqual(appliedNames(r), ['20260917000000_sim_a.sql', '20260918000000_sim_b.sql', GAP_ENTRY]);
});

test('SIM GAP CONTROL without the gap entries in the plan, the gap migration is never applied', () => {
  const r = gapRun(`${GAP_ENTRY}\n`, {}, [['tests/supabase-local/localStackPlan.ts', PLAN_ORDERED, '  return { aboveLedgerMax, baselineGaps, ordered: [...aboveLedgerMax] };']]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.result?.migrationsReplayed, 2, 'the control must observe the missing gap');
  assert.ok(!appliedNames(r).includes(GAP_ENTRY));
});

test('SIM GAP an invalid manifest stops the bootstrap before the stack starts (no partial replay)', () => {
  for (const [why, manifest] of [['above ledgerMax', '20260917000000_sim_a.sql\n'], ['duplicate', `${GAP_ENTRY}\n${GAP_ENTRY}\n`], ['missing file', '20260102000000_nope.sql\n'], ['path', `supabase/migrations/${GAP_ENTRY}\n`]]) {
    const r = gapRun(manifest);
    assert.notEqual(r.status, 0, `${why}: ${r.out}`);
    assert.equal(r.result?.status, 'failed', why);
    assert.ok(!r.calls.some((c) => c.startsWith('supabase start')), `${why}: the stack must not start`);
    assert.equal(migrationCalls(r.calls).length, 0, `${why}: no migration may be applied`);
    assert.match(r.out, /baseline-gap-migrations\.txt: entry/, why);
  }
});

test('SIM GAP a gap migration that fails to apply fails the bootstrap at that migration', () => {
  const r = gapRun(`${GAP_ENTRY}\n`, { SIM_PSQL_FAIL_FILE: GAP_ENTRY });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.result?.stage, 'migration-replay');
  assert.equal(r.result?.migrationsReplayed, 2);
  assert.match(r.out, /migration 20260101000000_before_ledger\.sql did not apply/);
});
