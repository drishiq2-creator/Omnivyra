import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Static lock on .github/workflows/auth-integrity.yml AFTER the hosted E2E retirement
 * (docs/supabase-e2e-retirement/15-application-and-ci-connection-transition.md, stage 2).
 *
 * The file now holds exactly ONE job: the hermetic static-invariant check that feeds the required
 * status context. The live suite runs against a DISPOSABLE Supabase stack in
 * .github/workflows/auth-integrity-local.yml instead (locked by
 * tests/supabase-local/authIntegrityLocalWorkflow.spec.ts).
 *
 * This spec fails if the hosted E2E job, its provisioning preflight, ANY repository secret, the
 * prod-DB/local-Redis bypass or a hosted Supabase marker is reintroduced, and if the required job
 * is renamed, gains secrets or loses its pull_request trigger.
 *
 * Hermetic: reads one file from disk and parses it. js-yaml is resolved from the lockfile's hoisted
 * dev tree; if it ever disappears this spec fails loudly rather than skipping.
 */
const yaml = createRequire(__filename)('js-yaml') as { load(source: string): unknown };

const WORKFLOW_PATH = path.join(__dirname, '..', '..', '.github', 'workflows', 'auth-integrity.yml');
const STATIC_JOB = 'auth-invariants-static';
const STATIC_JOB_REQUIRED_CONTEXT = 'Static auth invariants (hermetic, no secrets)';
/** Job ids of the retired hosted half. */
const RETIRED_JOBS = ['auth-integrity', 'e2e-secrets-preflight'];
const HOSTED_MARKERS = ['klkiseupptzbecbxwrky', 'lomndxmrpyudaegddpef', '.supabase.co', '.supabase.in', '.supabase.com'];

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, unknown> };
type Job = { name?: string; env?: Record<string, unknown>; steps?: Step[]; services?: unknown };
type Workflow = { on?: Record<string, unknown>; jobs: Record<string, Job> };

function loadWorkflow(source = fs.readFileSync(WORKFLOW_PATH, 'utf8')): Workflow {
  const parsed = yaml.load(source) as Workflow;
  assert.ok(parsed && parsed.jobs, 'auth-integrity.yml did not parse into a workflow with jobs');
  return parsed;
}

/** Every secret name referenced anywhere, in both `secrets.NAME` and `secrets['NAME']` forms. */
function referencedSecretNames(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const names = new Set<string>();
  for (const m of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/secrets\[\s*\\?['"]([^'"\\]+)\\?['"]\s*\]/g)) names.add(m[1]);
  return [...names].sort();
}

/** All problems with a workflow source; [] means the post-retirement shape holds. */
function checkWorkflow(source: string): string[] {
  const problems: string[] = [];
  let wf: Workflow;
  try {
    wf = loadWorkflow(source);
  } catch (e) {
    return [`does not parse: ${(e as Error).message}`];
  }
  const ids = Object.keys(wf.jobs);
  if (ids.join(',') !== STATIC_JOB) problems.push(`jobs must be exactly ${STATIC_JOB}, got ${ids.join(',')}`);
  for (const retired of RETIRED_JOBS) if (wf.jobs[retired]) problems.push(`retired hosted job "${retired}" is back`);
  const secrets = referencedSecretNames(source);
  if (secrets.length) problems.push(`references repository secret(s): ${secrets.join(', ')}`);
  if (/ALLOW_PROD_DB_WITH_LOCAL_REDIS/.test(source)) problems.push('sets or names ALLOW_PROD_DB_WITH_LOCAL_REDIS');
  const lowered = source.toLowerCase();
  for (const m of HOSTED_MARKERS) if (lowered.includes(m)) problems.push(`contains hosted marker ${m}`);
  const job = wf.jobs[STATIC_JOB];
  if (!job) {
    problems.push(`required job ${STATIC_JOB} is missing`);
  } else {
    if (job.name !== STATIC_JOB_REQUIRED_CONTEXT) problems.push(`required job must keep the name "${STATIC_JOB_REQUIRED_CONTEXT}"`);
    if (job.services) problems.push('the static job must not start services');
    const steps = job.steps ?? [];
    if (steps.some((s) => /npm (ci|install)\b/.test(String(s.run ?? '')))) problems.push('the static job must install nothing');
    if (!steps.some((s) => /node scripts\/check-auth-integrity-invariants\.js/.test(String(s.run ?? '')))) problems.push('the static job must run the invariant checker');
  }
  if (!wf.on || !('pull_request' in wf.on)) problems.push('the pull_request trigger feeds a required check and must stay');
  return problems;
}

const SOURCE = fs.readFileSync(WORKFLOW_PATH, 'utf8');

test('the workflow holds only the hermetic static job (hosted E2E retired)', () => {
  assert.deepEqual(checkWorkflow(SOURCE), []);
});

// ------------------------------------------------------------ FAILING CONTROLS
function expectDetected(label: string, from: string, to: string, problem: RegExp): void {
  assert.equal(SOURCE.split(from).length - 1, 1, `mutation anchor for "${label}" must occur exactly once`);
  const problems = checkWorkflow(SOURCE.replace(from, to));
  assert.ok(problems.some((p) => problem.test(p)), `${label}: expected a problem matching ${problem}, got ${JSON.stringify(problems)}`);
}

const HOSTED_JOB_SNIPPET = [
  '',
  '  auth-integrity:',
  '    name: Auth integrity regression lock',
  '    runs-on: ubuntu-24.04',
  '    env:',
  '      SUPABASE_URL: ${{ secrets.E2E_SUPABASE_URL }}',
  "      ALLOW_PROD_DB_WITH_LOCAL_REDIS: '1'",
  '    steps:',
  '      - run: npm run test:auth-integrity',
  '',
].join('\n');

test('CONTROL: reintroducing the hosted E2E job is detected', () => {
  const problems = checkWorkflow(`${SOURCE.trimEnd()}\n${HOSTED_JOB_SNIPPET}`);
  for (const re of [/jobs must be exactly/, /retired hosted job "auth-integrity"/, /E2E_SUPABASE_URL/, /ALLOW_PROD_DB_WITH_LOCAL_REDIS/]) {
    assert.ok(problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(problems)}`);
  }
});

test('CONTROL: a secret in the static job (bracket form too) is detected', () => {
  expectDetected('secret', 'run: node scripts/check-auth-integrity-invariants.js', "run: node scripts/check-auth-integrity-invariants.js ${{ secrets['SUPABASE_URL'] }}", /repository secret\(s\): SUPABASE_URL/);
});

test('CONTROL: renaming the required job is detected', () => {
  expectDetected('rename', `name: ${STATIC_JOB_REQUIRED_CONTEXT}`, 'name: Static auth invariants', /keep the name/);
});

test('CONTROL: dropping the pull_request trigger is detected', () => {
  expectDetected('trigger', '  pull_request:\n', '', /pull_request trigger/);
});

test('CONTROL: a hosted Supabase marker is detected', () => {
  expectDetected('marker', '# Static auth invariants ONLY', '# Static auth invariants ONLY https://lomndxmrpyudaegddpef.supabase.co', /hosted marker lomndxmrpyudaegddpef/);
});

test('CONTROL: installing dependencies in the static job is detected', () => {
  expectDetected('install', 'run: test -f scripts/check-auth-integrity-invariants.js', 'run: npm ci', /install nothing/);
});
