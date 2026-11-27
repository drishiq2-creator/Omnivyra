import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * E2E consolidation (docs/supabase-e2e-retirement/15-application-and-ci-connection-transition.md).
 *
 * Static lock on WHICH parts of the repository may connect to a hosted Supabase project:
 *   - the hosted E2E project (lomndxmrpyudaegddpef) may be reached ONLY through the allowlisted
 *     workflow(s) below, via E2E_-prefixed secrets. Stage 2 of the transition empties that list;
 *   - production-valued repository secrets (plain SUPABASE_* / NEXT_PUBLIC_SUPABASE_* names) may be
 *     read ONLY by platform-parity.yml, which audits the production deployment;
 *   - every literal Supabase URL in a workflow is a placeholder, a dry-run marker or loopback;
 *   - the prod-DB/local-Redis bypass (ALLOW_PROD_DB_WITH_LOCAL_REDIS) is set only where allowlisted;
 *   - application runtime code and deployment config never name the hosted E2E project or its
 *     variables (the app selects a project ONLY through SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL).
 *
 * Every rule is a pure function exercised first against synthetic input that MUST be refused (failing
 * control) and input that MUST pass, then against the real repository. Hermetic: reads files only.
 */
const yaml = createRequire(__filename)('js-yaml') as { load(source: string): unknown };

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

export const HOSTED_E2E_REFS: readonly string[] = ['lomndxmrpyudaegddpef'];
export const PRODUCTION_REFS: readonly string[] = ['klkiseupptzbecbxwrky'];

/**
 * Workflows allowed to read E2E_-prefixed secrets (i.e. to reach the hosted E2E project).
 * STAGE 2 (hosted E2E retired): none. The auth suite runs on a disposable stack (auth-integrity-local.yml).
 */
export const HOSTED_E2E_SECRET_WORKFLOWS: readonly string[] = [];
/** Workflows allowed to name the hosted E2E ref in text (comments / refusal markers). */
export const HOSTED_E2E_REF_WORKFLOWS: readonly string[] = [];
/** Workflows allowed to set ALLOW_PROD_DB_WITH_LOCAL_REDIS. STAGE 2: none. */
export const PROD_DB_LOCAL_REDIS_BYPASS_WORKFLOWS: readonly string[] = [];
/** Workflows allowed to read production-valued repository secrets. */
export const PRODUCTION_SECRET_WORKFLOWS: readonly string[] = ['platform-parity.yml'];

/** Plain (non-E2E) secret names that would carry hosted (production) connection values. */
const PRODUCTION_SECRET_PATTERN =
  /^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|DIRECT_URL$|REDIS_URL$|UPSTASH_|SESSION_COOKIE_SECRET$|ENCRYPTION_KEY$)/;

/** Literal values a workflow may assign to a *SUPABASE_URL variable. */
const ALLOWED_LITERAL_SUPABASE_URL = /^(https:\/\/placeholder\.supabase\.co\/?|dry-run|http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?)$/;

/** Text that application runtime / deployment config must never contain. */
const RUNTIME_FORBIDDEN: readonly string[] = [...HOSTED_E2E_REFS, 'E2E_SUPABASE', 'E2E_NEXT_PUBLIC_SUPABASE', '.env.e2e', 'AUTH_E2E_'];

/** Application runtime directories (what Vercel / Railway build and run). */
const RUNTIME_DIRS = ['pages', 'lib', 'backend', 'components', 'config', 'utils', 'shared', 'hooks', 'middleware', 'store', 'platform', 'modules', 'features', 'infra', 'types'];
/** Root-level runtime / deployment files. */
const RUNTIME_ROOT_FILES = ['next.config.js', 'proxy.ts', 'instrumentation.ts', 'instrumentation.node.ts', 'vercel.json', 'railway.json', 'Dockerfile.worker', 'Dockerfile.cron', 'docker-compose.yml'];
const RUNTIME_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json']);
/** Test code inside runtime directories is not runtime. */
function isTestPath(rel: string): boolean {
  return /(^|\/)(tests?|__tests__|__mocks__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

// ── pure rules ──────────────────────────────────────────────────────────────

/** Secret names in both `secrets.NAME` and `secrets['NAME']` forms (as authIntegrityWorkflow.spec.ts). */
export function secretNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/secrets\[\s*['"]([^'"]+)['"]\s*\]/g)) names.add(m[1]);
  return [...names].sort();
}

export function classifySecret(name: string): 'hosted-e2e' | 'production' | 'other' {
  if (/^E2E_/.test(name)) return 'hosted-e2e';
  if (PRODUCTION_SECRET_PATTERN.test(name)) return 'production';
  return 'other';
}

/** Every env map (workflow, job, step) as [where, key, value]. */
export function envEntries(workflow: unknown): Array<[string, string, unknown]> {
  const out: Array<[string, string, unknown]> = [];
  const wf = (workflow ?? {}) as { env?: Record<string, unknown>; jobs?: Record<string, { env?: Record<string, unknown>; steps?: Array<{ name?: string; env?: Record<string, unknown> }> }> };
  for (const [k, v] of Object.entries(wf.env ?? {})) out.push(['workflow', k, v]);
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    for (const [k, v] of Object.entries(job?.env ?? {})) out.push([`job ${jobId}`, k, v]);
    for (const [i, step] of (job?.steps ?? []).entries()) {
      for (const [k, v] of Object.entries(step?.env ?? {})) out.push([`job ${jobId} step ${step?.name ?? i}`, k, v]);
    }
  }
  return out;
}

/** Literal (non-expression) *SUPABASE_URL values that are not placeholder / dry-run / loopback. */
export function literalSupabaseUrlViolations(workflow: unknown): string[] {
  const out: string[] = [];
  for (const [where, key, value] of envEntries(workflow)) {
    if (!/SUPABASE_URL$/.test(key)) continue;
    if (typeof value !== 'string' || value.includes('${{')) continue;
    if (!ALLOWED_LITERAL_SUPABASE_URL.test(value.trim())) out.push(`${where}: ${key}`);
  }
  return out;
}

/** Workflow-level violations for one file (name = basename). */
export function workflowViolations(name: string, source: string): string[] {
  const out: string[] = [];
  for (const secret of secretNames(source)) {
    const cls = classifySecret(secret);
    if (cls === 'hosted-e2e' && !HOSTED_E2E_SECRET_WORKFLOWS.includes(name)) out.push(`${name} reads hosted-E2E secret ${secret}`);
    if (cls === 'production' && !PRODUCTION_SECRET_WORKFLOWS.includes(name)) out.push(`${name} reads production secret ${secret}`);
  }
  const lowered = source.toLowerCase();
  for (const ref of HOSTED_E2E_REFS) {
    if (lowered.includes(ref) && !HOSTED_E2E_REF_WORKFLOWS.includes(name)) out.push(`${name} names the hosted E2E project ${ref}`);
  }
  if (/ALLOW_PROD_DB_WITH_LOCAL_REDIS\s*:/.test(source) && !PROD_DB_LOCAL_REDIS_BYPASS_WORKFLOWS.includes(name)) {
    out.push(`${name} sets ALLOW_PROD_DB_WITH_LOCAL_REDIS`);
  }
  for (const v of literalSupabaseUrlViolations(yaml.load(source))) out.push(`${name} ${v} is a literal non-placeholder Supabase URL`);
  return out;
}

export function runtimeTextViolations(rel: string, text: string): string[] {
  const lowered = text.toLowerCase();
  return RUNTIME_FORBIDDEN.filter((m) => lowered.includes(m.toLowerCase())).map((m) => `${rel} contains "${m}"`);
}

function listWorkflows(): string[] {
  return fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
}

function walk(dirRel: string, out: string[]): void {
  const abs = path.join(ROOT, dirRel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.isFile() && RUNTIME_EXTENSIONS.has(path.extname(entry.name)) && !isTestPath(rel)) out.push(rel);
  }
}

// ── failing controls: each rule refuses a synthetic violation ──────────────

test('control: an unlisted workflow reading an E2E_ secret is refused', () => {
  const src = 'jobs:\n  a:\n    runs-on: x\n    env:\n      SUPABASE_URL: ${{ secrets.E2E_SUPABASE_URL }}\n';
  assert.deepEqual(workflowViolations('some-new.yml', src), ['some-new.yml reads hosted-E2E secret E2E_SUPABASE_URL']);
});

test('control: an unlisted workflow reading a production secret is refused', () => {
  const src = 'jobs:\n  a:\n    env:\n      K: ${{ secrets.SUPABASE_SECRET_KEY || secrets.NEXT_PUBLIC_SUPABASE_URL }}\n';
  assert.deepEqual(workflowViolations('x.yml', src), ['x.yml reads production secret NEXT_PUBLIC_SUPABASE_URL', 'x.yml reads production secret SUPABASE_SECRET_KEY']);
  // Bracket form is caught too.
  assert.deepEqual(workflowViolations('y.yml', "jobs:\n  a:\n    env:\n      K: ${{ secrets['E2E_SUPABASE_URL'] }}\n"), ['y.yml reads hosted-E2E secret E2E_SUPABASE_URL']);
});

test('control: naming the hosted E2E ref (any case) outside the allowlist is refused', () => {
  assert.deepEqual(workflowViolations('x.yml', '# target LOMNDXMRPYUDAEGDDPEF\njobs: {}\n'), ['x.yml names the hosted E2E project lomndxmrpyudaegddpef']);
});

test('control: setting the prod-DB/local-Redis bypass outside the allowlist is refused', () => {
  assert.deepEqual(workflowViolations('x.yml', "jobs:\n  a:\n    env:\n      ALLOW_PROD_DB_WITH_LOCAL_REDIS: '1'\n"), ['x.yml sets ALLOW_PROD_DB_WITH_LOCAL_REDIS']);
});

test('control: a literal hosted Supabase URL at workflow, job or step level is refused', () => {
  const src = [
    'env:',
    '  SUPABASE_URL: https://abcdefghijklmnopqrst.supabase.co',
    'jobs:',
    '  a:',
    '    env:',
    '      NEXT_PUBLIC_SUPABASE_URL: https://lomndxmrpyudaegddpef.supabase.co',
    '    steps:',
    '      - name: s',
    '        env:',
    '          E2E_SUPABASE_URL: http://10.0.0.5:54321',
    '',
  ].join('\n');
  assert.deepEqual(literalSupabaseUrlViolations(yaml.load(src)), [
    'workflow: SUPABASE_URL',
    'job a: NEXT_PUBLIC_SUPABASE_URL',
    'job a step s: E2E_SUPABASE_URL',
  ]);
});

test('control: placeholder, dry-run, loopback and expression values pass', () => {
  const src = [
    'jobs:',
    '  a:',
    '    env:',
    '      SUPABASE_URL: https://placeholder.supabase.co',
    "      NEXT_PUBLIC_SUPABASE_URL: 'dry-run'",
    '      E2E_SUPABASE_URL: http://127.0.0.1:54321',
    '      OTHER_SUPABASE_URL: ${{ steps.x.outputs.url }}',
    '',
  ].join('\n');
  assert.deepEqual(literalSupabaseUrlViolations(yaml.load(src)), []);
});

test('control: runtime text naming the hosted E2E project or its variables is refused', () => {
  assert.deepEqual(runtimeTextViolations('lib/x.ts', "const u = process.env.E2E_SUPABASE_URL; // .env.e2e"), [
    'lib/x.ts contains "E2E_SUPABASE"',
    'lib/x.ts contains ".env.e2e"',
  ]);
  assert.deepEqual(runtimeTextViolations('lib/y.ts', 'https://lomndxmrpyudaegddpef.supabase.co'), ['lib/y.ts contains "lomndxmrpyudaegddpef"']);
  assert.deepEqual(runtimeTextViolations('lib/z.ts', 'process.env.SUPABASE_URL'), []);
});

test('control: test files inside runtime directories are not runtime', () => {
  assert.equal(isTestPath('backend/tests/unit/a.test.ts'), true);
  assert.equal(isTestPath('lib/__tests__/a.ts'), true);
  assert.equal(isTestPath('lib/auth/rateLimit.spec.ts'), true);
  assert.equal(isTestPath('lib/auth/rateLimit.ts'), false);
});

// ── the real repository ────────────────────────────────────────────────────

test('every workflow obeys the hosted-connection allowlists', () => {
  const files = listWorkflows();
  assert.ok(files.length >= 10, `expected the workflow directory to be populated, found ${files.length}`);
  const violations = files.flatMap((f) => workflowViolations(f, fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')));
  assert.deepEqual(violations, []);
});

test('each allowlisted workflow exists and really is a consumer (no stale allowlist entry)', () => {
  const files = new Set(listWorkflows());
  for (const name of HOSTED_E2E_SECRET_WORKFLOWS) {
    assert.ok(files.has(name), `${name} is allowlisted but missing`);
    const src = fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8');
    assert.ok(secretNames(src).some((s) => classifySecret(s) === 'hosted-e2e'), `${name} is allowlisted for E2E_ secrets but reads none`);
  }
  for (const name of PROD_DB_LOCAL_REDIS_BYPASS_WORKFLOWS) {
    const src = fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8');
    assert.match(src, /ALLOW_PROD_DB_WITH_LOCAL_REDIS\s*:/, `${name} is allowlisted for the bypass but does not set it`);
  }
  for (const name of PRODUCTION_SECRET_WORKFLOWS) assert.ok(files.has(name), `${name} is allowlisted but missing`);
});

test('application runtime code and deployment config never name the hosted E2E project', () => {
  const files: string[] = [];
  for (const dir of RUNTIME_DIRS) walk(dir, files);
  for (const f of RUNTIME_ROOT_FILES) if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  // Non-vacuous: the scan must actually cover the server client, the browser client and deploy config.
  for (const must of ['backend/db/supabaseClient.ts', 'lib/supabaseBrowser.ts', 'lib/env/namespace.ts', 'vercel.json', 'railway.json']) {
    assert.ok(files.includes(must), `runtime scan does not cover ${must}`);
  }
  assert.ok(files.length > 1000, `runtime scan covered only ${files.length} files`);
  const violations = files.flatMap((f) => runtimeTextViolations(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(violations, []);
});
