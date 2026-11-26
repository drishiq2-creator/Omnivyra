/**
 * CI assertions for the advisory local-Supabase auth workflow
 * (.github/workflows/auth-integrity-local.yml). Pure parsing/checks; no network.
 *
 * Run with: node node_modules/tsx/dist/cli.mjs tests/supabase-local/ciAssertions.ts <command> [...]
 *   assert-env-local                         the process env must resolve to AUTH_E2E_TARGET=local, and NO
 *                                            environment value may name a hosted Supabase host or project ref
 *   assert-bootstrap-result <log> <n>        the log's BOOTSTRAP_RESULT must be ok, schemaMode full,
 *                                            migrationsReplayed == n, tables >= baseline minimum
 *   assert-suite-result <log> <specs> <tests>  the auth runner log must show exactly <specs> spec files and
 *                                            <tests> tests, all passed, none failed/skipped/todo/cancelled
 *   assert-no-hosted-in-log <log>            a log (e.g. the app server log) must not mention a hosted
 *                                            Supabase host or project ref
 * Messages never contain environment values.
 */
import fs from 'node:fs';
import path from 'node:path';

import { LEGACY_E2E_PROJECT_REFS, PRODUCTION_PROJECT_REFS, PRODUCTION_REDIS_HOSTNAMES, resolveAuthE2ETarget } from '../auth/e2eEnvironmentGuard';

export class CiAssertionError extends Error {
  constructor(message: string) {
    super(`[auth-local-ci] ${message}`);
    this.name = 'CiAssertionError';
  }
}

/** Hosted Supabase markers. Any of these in a local-mode environment or log means a hosted target leaked in. */
export const HOSTED_MARKERS: readonly string[] = [
  ...PRODUCTION_PROJECT_REFS,
  ...LEGACY_E2E_PROJECT_REFS,
  '.supabase.co',
  '.supabase.in',
  '.supabase.com',
  // hosted Redis (the production Redis is an Upstash host; v3, review finding F4)
  ...PRODUCTION_REDIS_HOSTNAMES,
  '.upstash.io',
];

/**
 * Names whose VALUES are secrets in the C3 jobs: the local stack's keys exported by the bootstrap
 * and the per-run app secrets. Their values are redacted from every evidence file before upload.
 */
export const REDACTED_VALUE_VARIABLES: readonly string[] = [
  'E2E_SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SESSION_COOKIE_SECRET', 'ENCRYPTION_KEY',
];

/**
 * URL user-info in any scheme, up to the LAST "@" of the token, so a password containing "@" or "/"
 * is removed whole (review R5). Over-redacting an "@" in a path is accepted.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s'"<>]*@/gi;

/**
 * Values the bootstrap asked GitHub to mask. `::add-mask::<value>` lines go to stdout (that is how
 * masking works), so a teed log contains the raw value; it is collected from the log itself and
 * redacted everywhere, independent of which variables the redacting step happens to have
 * (review R1).
 */
export function maskedValues(text: string): string[] {
  return [...text.matchAll(/::add-mask::(.*?)\r?$/gm)].map((m) => m[1]).filter((v) => v.length > 0);
}

function encodedForms(secret: string): string[] {
  return [...new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])];
}

/**
 * Replaces every occurrence of each secret value (at least 8 characters) and every URL user-info
 * with a marker. Returns the text and the number of replacements; values are never returned or
 * printed. (v3; review finding F17: uploaded logs must not carry credentials whatever the app logs.)
 */
export function redactSecrets(text: string, secrets: readonly string[]): { text: string; replaced: number } {
  let replaced = 0;
  let out = text;
  const forms = secrets.filter((s) => typeof s === 'string' && s.length >= 8).flatMap(encodedForms);
  for (const secret of [...new Set(forms)].sort((a, b) => b.length - a.length)) {
    const parts = out.split(secret);
    replaced += parts.length - 1;
    out = parts.join('[REDACTED]');
  }
  out = out.replace(URL_USERINFO, (_m, scheme: string) => {
    replaced += 1;
    return `${scheme}[REDACTED]@`;
  });
  return { text: out, replaced };
}

export function findHostedMarkers(text: string): string[] {
  const lowered = text.toLowerCase();
  return HOSTED_MARKERS.filter((m) => lowered.includes(m));
}

export function assertEnvLocal(env: Readonly<Record<string, string | undefined>>): void {
  if (env.AUTH_E2E_TARGET !== 'local') throw new CiAssertionError('AUTH_E2E_TARGET is not "local".');
  const target = resolveAuthE2ETarget(env); // throws on any doubt, never echoes values
  if (target.mode !== 'local') throw new CiAssertionError('resolver did not select local mode.');
  const offending = Object.entries(env)
    .filter(([, v]) => typeof v === 'string' && findHostedMarkers(v).length > 0)
    .map(([k]) => k)
    .sort();
  if (offending.length) throw new CiAssertionError(`environment variable(s) name a hosted Supabase target: ${offending.join(', ')} (values not shown).`);
}

export type BootstrapResult = { status: string; stage: string; schemaMode: string; tables: string; migrationsReplayed: number; warnings: string };

export function parseBootstrapResult(log: string): BootstrapResult {
  const lines = log.split(/\r?\n/).filter((l) => l.startsWith('BOOTSTRAP_RESULT '));
  if (lines.length === 0) throw new CiAssertionError('no BOOTSTRAP_RESULT line in the bootstrap log.');
  if (lines.length > 1) throw new CiAssertionError(`expected exactly one BOOTSTRAP_RESULT line, found ${lines.length}.`);
  try {
    return JSON.parse(lines[0].slice('BOOTSTRAP_RESULT '.length)) as BootstrapResult;
  } catch {
    throw new CiAssertionError('BOOTSTRAP_RESULT is not valid JSON.');
  }
}

export function assertBootstrapResult(log: string, expectedMigrations: number, minTables: number): BootstrapResult {
  const r = parseBootstrapResult(log);
  if (r.status !== 'ok') throw new CiAssertionError(`bootstrap status "${r.status}" at stage "${r.stage}".`);
  if (r.stage !== 'complete') throw new CiAssertionError(`bootstrap ended at stage "${r.stage}", not "complete".`);
  if (r.schemaMode !== 'full') throw new CiAssertionError(`schema mode "${r.schemaMode}" is not "full".`);
  if (r.migrationsReplayed !== expectedMigrations) throw new CiAssertionError(`replayed ${r.migrationsReplayed} migrations, expected ${expectedMigrations}.`);
  const tables = Number(r.tables);
  if (!Number.isInteger(tables) || tables < minTables) throw new CiAssertionError(`public tables "${r.tables}" below the baseline minimum ${minTables}.`);
  if (r.warnings) throw new CiAssertionError(`bootstrap reported warnings: ${r.warnings}`);
  return r;
}

export type SuiteResult = { specs: number; tests: number; pass: number; fail: number; skipped: number; todo: number; cancelled: number; summaryLine: string };

/**
 * Parses the output of scripts/run-auth-integrity-tests.js (one `node --test` run per spec, each
 * printing "# tests N", "# pass N", ...; then "N/N specs passed, M failed").
 */
export function parseSuiteLog(log: string): SuiteResult {
  const sum = (key: string): { total: number; blocks: number } => {
    const re = new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm');
    let total = 0;
    let blocks = 0;
    for (const m of log.matchAll(re)) {
      total += Number(m[1]);
      blocks += 1;
    }
    return { total, blocks };
  };
  const tests = sum('tests');
  const summaryLine = (/^\d+\/\d+ specs passed, \d+ failed\s*$/m.exec(log) ?? [''])[0].trim();
  return {
    specs: tests.blocks,
    tests: tests.total,
    pass: sum('pass').total,
    fail: sum('fail').total,
    skipped: sum('skipped').total,
    todo: sum('todo').total,
    cancelled: sum('cancelled').total,
    summaryLine,
  };
}

export function assertSuiteResult(log: string, expectedSpecs: number, expectedTests: number): SuiteResult {
  const r = parseSuiteLog(log);
  const problems: string[] = [];
  if (r.specs !== expectedSpecs) problems.push(`spec runs ${r.specs} != ${expectedSpecs}`);
  if (r.tests !== expectedTests) problems.push(`tests ${r.tests} != ${expectedTests}`);
  if (r.pass !== expectedTests) problems.push(`passed ${r.pass} != ${expectedTests}`);
  if (r.fail || r.skipped || r.todo || r.cancelled) problems.push(`fail ${r.fail}, skipped ${r.skipped}, todo ${r.todo}, cancelled ${r.cancelled} (all must be 0)`);
  if (r.summaryLine !== `${expectedSpecs}/${expectedSpecs} specs passed, 0 failed`) problems.push(`runner summary "${r.summaryLine}"`);
  if (problems.length) throw new CiAssertionError(`auth suite result rejected: ${problems.join('; ')}.`);
  return r;
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'assert-env-local':
      assertEnvLocal(process.env);
      console.log('AUTH_LOCAL_ENV ok: local mode; no hosted Supabase marker in any environment variable');
      return 0;
    case 'assert-bootstrap-result': {
      const root = path.resolve(__dirname, '..', '..');
      const minTables = Number(JSON.parse(fs.readFileSync(path.join(root, 'supabase', '_schema', 'baseline.json'), 'utf8')).tables);
      const r = assertBootstrapResult(fs.readFileSync(args[0], 'utf8'), Number(args[1]), minTables);
      console.log(`BOOTSTRAP_VERIFIED ${JSON.stringify(r)}`);
      return 0;
    }
    case 'assert-suite-result': {
      const r = assertSuiteResult(fs.readFileSync(args[0], 'utf8'), Number(args[1]), Number(args[2]));
      console.log(`AUTH_SUITE_RESULT ${JSON.stringify({ status: 'pass', ...r })}`);
      return 0;
    }
    case 'assert-no-hosted-in-log': {
      const found = findHostedMarkers(fs.readFileSync(args[0], 'utf8'));
      if (found.length) throw new CiAssertionError(`log mentions hosted Supabase marker(s): ${found.join(', ')}.`);
      console.log('HOSTED_TARGET_CONTACT NONE (no hosted Supabase marker in the log)');
      return 0;
    }
    case 'redact-logs': {
      const present = args.filter((file) => fs.existsSync(file));
      for (const file of args) if (!present.includes(file)) console.log(`REDACT ${path.basename(file)}: absent`);
      // Secrets: the step's variables AND every value masked in ANY of the files (review R1).
      const secrets = [
        ...REDACTED_VALUE_VARIABLES.map((name) => process.env[name] ?? '').filter(Boolean),
        ...present.flatMap((file) => maskedValues(fs.readFileSync(file, 'utf8'))),
      ];
      let total = 0;
      for (const file of present) {
        const r = redactSecrets(fs.readFileSync(file, 'utf8'), secrets);
        fs.writeFileSync(file, r.text);
        total += r.replaced;
        console.log(`REDACT ${path.basename(file)}: ${r.replaced} replacement(s)`);
      }
      console.log(`REDACT_TOTAL ${total}`);
      return 0;
    }
    default:
      console.error('usage: ciAssertions.ts assert-env-local | assert-bootstrap-result <log> <n> | assert-suite-result <log> <specs> <tests> | assert-no-hosted-in-log <log> | redact-logs <file>...');
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
