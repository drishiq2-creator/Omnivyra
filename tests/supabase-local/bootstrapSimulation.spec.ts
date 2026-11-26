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
  for (const d of ['stub-bin', 'runner-temp', 'supabase/_schema', 'supabase/migrations', 'tests/supabase-local/supabase', 'tests/auth', 'node_modules/tsx/dist']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'omnivyra-admin-ui', private: true }));
  fs.writeFileSync(path.join(root, 'supabase/_schema/baseline.json'), JSON.stringify({ ledgerMax: '20260916000000', tables: 1 }));
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
