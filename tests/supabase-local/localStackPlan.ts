/**
 * Decision logic for tests/supabase-local/bootstrap.sh (workstream C1).
 *
 * Everything that can be decided without starting a container lives here, so it is
 * unit-testable on any machine. The shell script only orchestrates commands on a
 * GitHub-hosted CI runner. Local-target validation is NOT re-implemented here: it
 * reuses the single implementation in tests/auth/e2eEnvironmentGuard.ts.
 *
 * CLI (run with: node node_modules/tsx/dist/cli.mjs tests/supabase-local/localStackPlan.ts <cmd>):
 *   plan                                  print the bootstrap plan (no side effects)
 *   check-ci                              exit 0 only on a GitHub-hosted CI runner
 *   check-env                             exit 0 only if no hosted-Supabase variables are set
 *   migrations                            print the migration files the replay will apply, one per line
 *   min-tables                            print the baseline's expected minimum public table count
 *   classify-restore <stderr-file>        exit 0 if baseline-restore errors are only "already exists"
 *   export-env <status-env-file> <out>    validate `supabase status -o env` output and write the
 *                                         auth-suite environment (KEY=value lines) to <out>
 * Every command prints secret-free messages only. (Health probes are done by bootstrap.sh with
 * curl against the API URL that export-env has already validated as loopback.)
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  LOCAL_REDIS_PORT,
  LOCAL_STACK_PORTS,
  assertLocalLoopbackEndpoint,
  assertStrictLocalText,
  DB_LOCAL_RULE,
  SUPABASE_LOCAL_RULE,
  resolveAuthE2ETarget,
} from '../auth/e2eEnvironmentGuard';

export const PINNED_SUPABASE_CLI_VERSION = '2.122.0';
export const REPO_PACKAGE_NAME = 'omnivyra-admin-ui';
export const WORKDIR_RELATIVE = 'tests/supabase-local';

type EnvLike = Readonly<Record<string, string | undefined>>;

export class LocalStackPlanError extends Error {
  constructor(message: string) {
    super(`[supabase-local] ${message}`);
    this.name = 'LocalStackPlanError';
  }
}

/** Minimal reader for the two port settings and project_id (the TOML is also validated by a full parser in CI docs). */
export function readStackConfig(tomlText: string): { projectId: string; apiPort: number; dbPort: number } {
  const projectId = /^project_id\s*=\s*"([^"]+)"\s*$/m.exec(tomlText)?.[1];
  const section = (name: string): string => tomlText.split(/^\[/m).find((b) => b.startsWith(`${name}]`)) ?? '';
  const port = (name: string): number => Number(/^port\s*=\s*(\d+)\s*$/m.exec(section(name))?.[1] ?? NaN);
  const apiPort = port('api');
  const dbPort = port('db');
  if (!projectId) throw new LocalStackPlanError('config.toml has no project_id.');
  if (!Number.isInteger(apiPort) || !Number.isInteger(dbPort)) throw new LocalStackPlanError('config.toml lacks [api].port or [db].port.');
  if (apiPort !== LOCAL_STACK_PORTS.api || dbPort !== LOCAL_STACK_PORTS.db) {
    throw new LocalStackPlanError(`config.toml ports (${apiPort}/${dbPort}) differ from the guard's LOCAL_STACK_PORTS (${LOCAL_STACK_PORTS.api}/${LOCAL_STACK_PORTS.db}).`);
  }
  return { projectId, apiPort, dbPort };
}

/** The bootstrap refuses to start containers anywhere but a GitHub-hosted, ephemeral CI runner. */
export function assertGitHubHostedRunner(env: EnvLike): void {
  const ok =
    env.GITHUB_ACTIONS === 'true' && env.CI === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && !!env.GITHUB_RUN_ID;
  if (!ok) {
    throw new LocalStackPlanError(
      'refusing: this bootstrap starts containers and runs only on a GitHub-hosted CI runner ' +
        '(GITHUB_ACTIONS=true, CI=true, RUNNER_ENVIRONMENT=github-hosted, GITHUB_RUN_ID set). It never runs on a laptop.',
    );
  }
}

/**
 * Variables that would let the Supabase CLI resolve or authenticate to a HOSTED project.
 * The bootstrap refuses to run while any is set (it does not silently unset them).
 */
export const HOSTED_SUPABASE_VARIABLES = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_ID', 'SUPABASE_DB_PASSWORD', 'SUPABASE_PROJECT_REF'] as const;

/**
 * SUPABASE_* names that may be present while the bootstrap runs: the workflow's CLI pin, and the two
 * app variables the bootstrap itself exports to later steps (job 2's teardown runs after export).
 * The bootstrap strips the latter from the CLI's environment (run_supabase). Every other SUPABASE_*
 * name is refused: the CLI reads SUPABASE_<SECTION>_<KEY> overrides of config.toml (for example
 * SUPABASE_AUTH_SITE_URL) and SUPABASE_WORKDIR. (v3; review finding F15.)
 */
export const BOOTSTRAP_ALLOWED_SUPABASE_VARIABLES = ['SUPABASE_CLI_VERSION', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'] as const;

export function assertNoHostedSupabaseEnv(env: EnvLike, workdirAbs: string): void {
  const isSet = (name: string): boolean => typeof env[name] === 'string' && env[name]!.trim() !== '';
  const set = HOSTED_SUPABASE_VARIABLES.filter(isSet);
  if (set.length) throw new LocalStackPlanError(`refusing: hosted-Supabase variable(s) set: ${set.join(', ')} (values not shown).`);
  const names = Object.keys(env).filter((name) => env[name] !== undefined);
  const cliOverrides = names.filter((n) => /^SUPABASE_/i.test(n) && !(BOOTSTRAP_ALLOWED_SUPABASE_VARIABLES as readonly string[]).includes(n));
  if (cliOverrides.length) throw new LocalStackPlanError(`refusing: Supabase CLI override variable(s) set: ${cliOverrides.sort().join(', ')} (values not shown).`);
  // libpq reads PG* variables (PGHOST, PGHOSTADDR, PGSERVICE, PGSYSCONFDIR, PGPASSFILE, ...). psql
  // also runs with an empty environment, but their presence is refused so the run is unambiguous.
  const libpq = names.filter((n) => /^PG[A-Z0-9_]*$/i.test(n));
  if (libpq.length) throw new LocalStackPlanError(`refusing: libpq connection variable(s) set: ${libpq.sort().join(', ')} (values not shown).`);
  for (const linkFile of ['supabase/.temp/project-ref', 'supabase/.temp/pooler-url']) {
    if (fs.existsSync(path.join(workdirAbs, linkFile))) throw new LocalStackPlanError(`refusing: ${linkFile} exists in the local workdir (a hosted link).`);
  }
}

/** Same selection rule as scripts/ci/real-schema-ci.sh: 14-digit versions strictly above the baseline's ledgerMax, in order. */
export function selectMigrations(fileNames: readonly string[], ledgerMax: string): string[] {
  if (!/^\d{14}$/.test(ledgerMax)) throw new LocalStackPlanError(`baseline ledgerMax "${ledgerMax}" is not a 14-digit version.`);
  return fileNames
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const ver = f.split('_')[0];
      return /^\d{14}$/.test(ver) && ver > ledgerMax;
    })
    .sort();
}

/**
 * Lines that mean the restore did not run to completion, whatever psql's exit status: server-side
 * FATAL/PANIC, and every libpq / psql connection-loss message. (Review B2: these are not "ERROR:"
 * lines, so v3 ignored them.)
 */
const RESTORE_FAILURE_PATTERNS: readonly RegExp[] = [
  /\bFATAL:/,
  /\bPANIC:/,
  /server closed the connection unexpectedly/i,
  /terminating connection/i,
  /connection to server .*(failed|lost)/i,
  /no connection to the server/i,
  /could not (connect|receive data|send data)/i,
  /lost synchronization with server/i,
  /SSL SYSCALL error/i,
  /connection (lost|terminated|reset)/i,
  /the connection to the server was lost/i,
];

/**
 * Same tolerance as real-schema-ci, and nothing more: when restoring a pg_dump onto a stack that
 * already has some objects, a plain `ERROR: ... already exists` is expected. Every other ERROR line,
 * and every FATAL / PANIC / connection-loss line, is unexpected. A line never counts as tolerated
 * if it also carries a failure pattern.
 */
export function classifyRestoreErrors(stderrText: string): { total: number; unexpected: string[] } {
  const lines = stderrText.split(/\r?\n/);
  const isFailure = (l: string): boolean => RESTORE_FAILURE_PATTERNS.some((p) => p.test(l));
  const relevant = lines.filter((l) => /\bERROR:/.test(l) || isFailure(l));
  const tolerated = (l: string): boolean => /\bERROR:/.test(l) && /already exists/.test(l) && !isFailure(l);
  return { total: relevant.length, unexpected: relevant.filter((l) => !tolerated(l)) };
}

/** Diagnostics are shown with any URL user-info removed (a libpq message can quote a URL). */
export function redactConnectionText(line: string): string {
  return line.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s'"<>]*@/gi, '$1[REDACTED]@');
}

/**
 * Parses `supabase status -o env` output (KEY="value" or KEY=value lines). A key that occurs more
 * than once is refused: consumers that keep the first and the last occurrence would otherwise use
 * different values (v3; review finding F8).
 */
export function parseStatusEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(?:"(.*)"|(.*))$/.exec(line.trim());
    if (!m) continue;
    if (Object.prototype.hasOwnProperty.call(out, m[1])) throw new LocalStackPlanError(`\`supabase status -o env\` printed ${m[1]} more than once; refused.`);
    out[m[1]] = m[2] ?? m[3] ?? '';
  }
  return out;
}

/** The validated stack endpoints, exactly as validated; the bootstrap uses only these strings. */
export function buildStackEndpoints(status: Record<string, string>): { STACK_API_URL: string; STACK_DB_URL: string } {
  buildAuthSuiteEnv(status);
  return { STACK_API_URL: status.API_URL, STACK_DB_URL: status.DB_URL };
}

/**
 * Builds the auth-suite environment from the local stack's status, then proves it
 * with the REAL resolver in local mode. Returns KEY=value pairs; throws on any doubt.
 */
export function buildAuthSuiteEnv(status: Record<string, string>): Record<string, string> {
  const apiUrl = status.API_URL;
  const dbUrl = status.DB_URL;
  const secret = status.SECRET_KEY || status.SERVICE_ROLE_KEY;
  const publishable = status.PUBLISHABLE_KEY || status.ANON_KEY;
  if (!apiUrl || !dbUrl || !secret || !publishable) {
    throw new LocalStackPlanError('`supabase status -o env` lacks API_URL, DB_URL, a secret/service-role key or a publishable/anon key.');
  }
  // The same strict raw-text rule the resolver applies to every local endpoint: no character that
  // URL parsers read differently, at most one "@" (libpq splits user-info at the FIRST "@" and
  // accepts host lists; WHATWG at the last). (Review R3.)
  assertStrictLocalText('API_URL', apiUrl);
  assertStrictLocalText('DB_URL', dbUrl);
  assertLocalLoopbackEndpoint('API_URL', apiUrl, SUPABASE_LOCAL_RULE);
  assertLocalLoopbackEndpoint('DB_URL', dbUrl, DB_LOCAL_RULE);
  const env: Record<string, string> = {
    AUTH_E2E_TARGET: 'local',
    E2E_SUPABASE_URL: apiUrl,
    SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    E2E_SUPABASE_SECRET_KEY: secret,
    SUPABASE_SECRET_KEY: secret,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable,
  };
  // The same resolver the harness uses must accept exactly this environment.
  // AUTH_E2E_BASE_URL / REDIS_URL: the job's app and loopback Redis service, as the workflow sets them.
  resolveAuthE2ETarget({ ...env, AUTH_E2E_BASE_URL: 'http://localhost:3000', REDIS_URL: `redis://127.0.0.1:${LOCAL_REDIS_PORT}` });
  return env;
}

export function repoRootFrom(scriptDir: string): string {
  const root = path.resolve(scriptDir, '..', '..');
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new LocalStackPlanError('repository root not found (no package.json two levels up).');
  const name = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name;
  if (name !== REPO_PACKAGE_NAME) throw new LocalStackPlanError(`unexpected repository (package name "${name}").`);
  return root;
}

function readBaselineMeta(root: string): { ledgerMax: string; tables: number } {
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'supabase', '_schema', 'baseline.json'), 'utf8'));
  return { ledgerMax: String(meta.ledgerMax), tables: Number(meta.tables) };
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  const root = repoRootFrom(__dirname);
  const workdir = path.join(root, WORKDIR_RELATIVE);
  switch (cmd) {
    case 'plan': {
      const cfg = readStackConfig(fs.readFileSync(path.join(workdir, 'supabase', 'config.toml'), 'utf8'));
      const meta = readBaselineMeta(root);
      const migrations = selectMigrations(fs.readdirSync(path.join(root, 'supabase', 'migrations')), meta.ledgerMax);
      for (const f of ['supabase/_schema/baseline.sql', 'supabase/_schema/baseline.json', `${WORKDIR_RELATIVE}/stack-extensions.sql`]) {
        if (!fs.existsSync(path.join(root, f))) throw new LocalStackPlanError(`missing ${f}`);
      }
      console.log(JSON.stringify({
        workdir: WORKDIR_RELATIVE, projectId: cfg.projectId, apiPort: cfg.apiPort, dbPort: cfg.dbPort,
        pinnedCli: PINNED_SUPABASE_CLI_VERSION, baselineLedgerMax: meta.ledgerMax, baselineMinTables: meta.tables,
        migrationsToReplay: migrations.length, firstMigration: migrations[0] ?? null, lastMigration: migrations[migrations.length - 1] ?? null,
      }));
      return 0;
    }
    case 'check-ci':
      assertGitHubHostedRunner(process.env);
      return 0;
    case 'check-env':
      assertNoHostedSupabaseEnv(process.env, workdir);
      return 0;
    case 'validated-db-url': {
      // Prints the strictly validated DB URL from a `supabase status -o env` file (job 1's schema check).
      console.log(buildStackEndpoints(parseStatusEnv(fs.readFileSync(args[0], 'utf8'))).STACK_DB_URL);
      return 0;
    }
    case 'migration-count': {
      const meta = readBaselineMeta(root);
      console.log(String(selectMigrations(fs.readdirSync(path.join(root, 'supabase', 'migrations')), meta.ledgerMax).length));
      return 0;
    }
    case 'migrations': {
      const meta = readBaselineMeta(root);
      for (const f of selectMigrations(fs.readdirSync(path.join(root, 'supabase', 'migrations')), meta.ledgerMax)) console.log(f);
      return 0;
    }
    case 'min-tables':
      console.log(String(readBaselineMeta(root).tables));
      return 0;
    case 'classify-restore': {
      const r = classifyRestoreErrors(fs.readFileSync(args[0], 'utf8'));
      console.log(JSON.stringify({ restoreErrors: r.total, unexpected: r.unexpected.length }));
      for (const l of r.unexpected.slice(0, 20)) console.error(redactConnectionText(l));
      return r.unexpected.length ? 1 : 0;
    }
    case 'export-env': {
      if (!args[0] || !args[1] || !args[2]) throw new LocalStackPlanError('usage: export-env <status.env> <auth.env out> <stack.env out>');
      const status = parseStatusEnv(fs.readFileSync(args[0], 'utf8'));
      const env = buildAuthSuiteEnv(status);
      const stack = buildStackEndpoints(status);
      const write = (file: string, values: Record<string, string>): void => {
        fs.writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
      };
      write(args[1], env);
      write(args[2], stack);
      console.log(JSON.stringify({ exported: Object.keys(env), stack: Object.keys(stack) }));
      return 0;
    }
    default:
      console.error('usage: localStackPlan.ts plan|check-ci|check-env|migrations|migration-count|validated-db-url <status>|min-tables|classify-restore <f>|export-env <in> <auth out> <stack out>');
      return 2;
  }
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
