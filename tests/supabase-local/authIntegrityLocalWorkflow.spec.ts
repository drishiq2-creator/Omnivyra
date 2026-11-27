import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

/**
 * Static lock on .github/workflows/auth-integrity-local.yml (C3, advisory). Hermetic: reads files and
 * parses YAML; no network. checkWorkflow() returns every violated rule; the controls at the end mutate the
 * workflow text and prove each key rule is detected.
 */
const yaml = createRequire(__filename)('js-yaml') as { load(source: string): unknown };
const ROOT = path.resolve(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const WF_FILE = path.join(WF_DIR, 'auth-integrity-local.yml');
const SOURCE = fs.readFileSync(WF_FILE, 'utf8');

type Step = { id?: string; name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown>; 'continue-on-error'?: unknown };
type Job = { name?: string; 'runs-on'?: string; needs?: string | string[]; env?: Record<string, unknown>; steps?: Step[]; 'continue-on-error'?: unknown; services?: Record<string, { image?: string }> };
type Workflow = { name?: string; on?: Record<string, unknown>; permissions?: Record<string, string>; defaults?: { run?: { shell?: string } }; env?: Record<string, unknown>; jobs?: Record<string, Job> };

function load(text: string): Workflow {
  const parsed = yaml.load(text) as Record<string | number, unknown>;
  const wf = parsed as unknown as Workflow;
  // js-yaml (YAML 1.1) may read the key `on` as boolean true.
  if (wf.on === undefined && (parsed as Record<string, unknown>)['true'] !== undefined) wf.on = (parsed as Record<string, unknown>)['true'] as Record<string, unknown>;
  return wf;
}

function otherJobNamesAndIds(): Set<string> {
  const out = new Set<string>();
  for (const f of fs.readdirSync(WF_DIR)) {
    if (!/\.ya?ml$/.test(f) || f === 'auth-integrity-local.yml') continue;
    const wf = load(fs.readFileSync(path.join(WF_DIR, f), 'utf8'));
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      out.add(id);
      if (job && typeof job.name === 'string') out.add(job.name);
    }
  }
  return out;
}

function expectedAuthCounts(): { specs: number; tests: number } {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'run-auth-integrity-tests.js'), 'utf8');
  const specs = [...runner.matchAll(/'(tests\/auth\/[^']+\.spec\.ts)'/g)].map((m) => m[1]);
  let tests = 0;
  for (const s of specs) tests += [...fs.readFileSync(path.join(ROOT, s), 'utf8').matchAll(/^test(?:\.only)?\(/gm)].length;
  return { specs: specs.length, tests };
}

const stepIndex = (steps: Step[], re: RegExp): number => steps.findIndex((s) => re.test(String(s.run ?? '')) || re.test(String(s.uses ?? '')));

function checkWorkflow(text: string): string[] {
  const problems: string[] = [];
  const add = (p: string) => problems.push(p);
  let wf: Workflow;
  try {
    wf = load(text);
  } catch (e) {
    return [`YAML does not parse: ${(e as Error).message}`];
  }
  if (/\$\{\{\s*secrets[.[]/.test(text)) add('references a repository secret');
  for (const marker of ['klkiseupptzbecbxwrky', 'lomndxmrpyudaegddpef', '.supabase.co', '.supabase.in']) if (text.includes(marker)) add(`contains hosted marker ${marker}`);
  const on = wf.on ?? {};
  const triggers = Object.keys(on).sort();
  if (triggers.join(',') !== 'push,workflow_dispatch') add(`triggers must be exactly push + workflow_dispatch, got ${triggers.join(',')}`);
  const push = on.push as { branches?: string[]; tags?: unknown; paths?: unknown } | null | undefined;
  if (!push || JSON.stringify(push.branches) !== JSON.stringify(['ci-only/c3-auth-local/**']) || Object.keys(push).length !== 1) add('push must be limited to branches ci-only/c3-auth-local/** only');
  if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: 'read' })) add('permissions must be exactly contents: read');
  if (wf.defaults?.run?.shell !== 'bash') add('defaults.run.shell must be bash (pipefail)');
  const pinned = /PINNED_CLI="([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, 'tests', 'supabase-local', 'bootstrap.sh'), 'utf8'))?.[1];
  if (String(wf.env?.SUPABASE_CLI_VERSION) !== pinned) add('SUPABASE_CLI_VERSION must equal the bootstrap pin');
  const counts = expectedAuthCounts();
  if (String(wf.env?.EXPECTED_AUTH_SPECS) !== String(counts.specs) || String(wf.env?.EXPECTED_AUTH_TESTS) !== String(counts.tests)) add(`expected counts must equal the runner's ${counts.specs} specs / ${counts.tests} tests`);
  const jobs = wf.jobs ?? {};
  const ids = Object.keys(jobs);
  if (ids.sort().join(',') !== 'auth-integrity-local,local-stack-validation') add(`jobs must be exactly local-stack-validation and auth-integrity-local, got ${ids.join(',')}`);
  const others = otherJobNamesAndIds();
  for (const [id, job] of Object.entries(jobs)) {
    if (others.has(id) || (job.name && others.has(job.name))) add(`job ${id} reuses an existing job id or name (could satisfy a required context)`);
    if (!job.name || !/\badvisory\)$/.test(job.name)) add(`job ${id} name must end with "advisory)"`);
    if (!/^ubuntu-\d/.test(String(job['runs-on']))) add(`job ${id} must run on a GitHub-hosted ubuntu runner`);
    if (job['continue-on-error'] !== undefined) add(`job ${id} must not use continue-on-error`);
    if (job.env && 'ALLOW_PROD_DB_WITH_LOCAL_REDIS' in job.env) add(`job ${id} sets ALLOW_PROD_DB_WITH_LOCAL_REDIS`);
    const steps = job.steps ?? [];
    for (const s of steps) {
      if (s['continue-on-error'] !== undefined) add(`step "${s.name}" uses continue-on-error`);
      if (/\|\|\s*true\b/.test(String(s.run ?? ''))) add(`step "${s.name}" swallows failures with || true`);
      if (/--schema-mode\s+baseline-only/.test(String(s.run ?? ''))) add(`step "${s.name}" skips migrations`);
      if (/\bsupabase\s+(link|db\s+(push|pull|dump)|migration\s+(up|repair))\b|--linked|--project-ref/.test(String(s.run ?? ''))) add(`step "${s.name}" uses a hosted Supabase command`);
    }
    const up = stepIndex(steps, /bootstrap\.sh up\b/);
    const down = stepIndex(steps, /bootstrap\.sh down\b/);
    const verify = stepIndex(steps, /assert-bootstrap-result/);
    if (up < 0) add(`job ${id} never starts the stack`);
    if (down < 0 || down < up) add(`job ${id} must tear down after starting`);
    else if (!/always\(\)/.test(String(steps[down].if ?? ''))) add(`job ${id} teardown must run if: always()`);
    if (verify < 0 || verify < up || verify > down) add(`job ${id} must verify the bootstrap result between up and down`);
    if (/--env-out\s+"\$GITHUB_ENV"/.test(String(steps[up]?.run ?? '')) && id !== 'auth-integrity-local') add(`job ${id} must not export the stack env`);
    // v3 (review finding F17): every uploaded evidence file is redacted first, even after a failure.
    const upload = steps.findIndex((st) => String(st.uses ?? '').startsWith('actions/upload-artifact'));
    const redact = stepIndex(steps, /ciAssertions\.ts redact-logs/);
    if (upload >= 0) {
      if (!(redact >= 0 && redact < upload && /always\(\)/.test(String(steps[redact].if ?? '')))) add(`job ${id} must redact credentials (if: always()) before uploading evidence`);
      // Review R2: no upload unless the redaction itself succeeded.
      const redactId = redact >= 0 ? steps[redact].id : undefined;
      if (!redactId || String(steps[upload].if ?? '') !== `always() && steps.${redactId}.outcome == 'success'`) add(`job ${id}: upload must require a successful redaction`);
      const paths = String(steps[upload].with?.path ?? '').split('\n').map((p) => p.trim()).filter(Boolean);
      for (const p of paths.filter((x) => x.startsWith('${{ runner.temp }}/'))) {
        const name = p.slice('${{ runner.temp }}/'.length);
        if (!String(steps[redact]?.run ?? '').includes(`"$RUNNER_TEMP/${name}"`)) add(`job ${id} uploads ${name} without redacting it`);
      }
      if (paths.some((p) => p.startsWith('test-results/')) && !paths.includes('!test-results/auth-integrity/**/storage-state.json')) add(`job ${id} uploads browser storage state (live session tokens)`);
    }
  }
  // v3 (review finding F12): every offline spec in tests/supabase-local runs in CI; none can be skipped by omission.
  const unit = jobs['local-stack-validation']?.steps?.find((st) => /--test tests\/supabase-local\//.test(String(st.run ?? '')));
  for (const spec of fs.readdirSync(path.join(ROOT, 'tests', 'supabase-local')).filter((n) => n.endsWith('.spec.ts'))) {
    if (!String(unit?.run ?? '').includes(`tests/supabase-local/${spec}`)) add(`offline spec tests/supabase-local/${spec} is not run by the workflow`);
  }
  const auth = jobs['auth-integrity-local'];
  if (auth) {
    const steps = auth.steps ?? [];
    if (JSON.stringify(auth.needs) !== JSON.stringify('local-stack-validation')) add('auth job must need local-stack-validation');
    if (auth.services?.redis?.image !== 'redis:7-alpine') add('auth job must use the redis:7-alpine service');
    if (!/^redis:\/\/127\.0\.0\.1:6379$/.test(String(auth.env?.REDIS_URL))) add('auth job REDIS_URL must be the loopback service');
    const secretsGen = stepIndex(steps, /openssl rand -hex 32/);
    const up = stepIndex(steps, /bootstrap\.sh up --env-out "\$GITHUB_ENV"/);
    const envLocal = stepIndex(steps, /assert-env-local/);
    const target = stepIndex(steps, /check:auth-e2e-target/);
    const server = stepIndex(steps, /npm run dev/);
    const suite = stepIndex(steps, /npm run test:auth-integrity/);
    const result = stepIndex(steps, /assert-suite-result/);
    const logScan = stepIndex(steps, /assert-no-hosted-in-log/);
    const down = stepIndex(steps, /bootstrap\.sh down\b/);
    if (!(secretsGen >= 0 && secretsGen < up)) add('per-run app secrets must be generated before the stack env is exported');
    if (!(up >= 0 && envLocal > up && target > up)) add('local-only assertions must follow the stack export');
    if (!(server > envLocal && server > target)) add('hosted-target refusals must precede the app server');
    if (!(suite > server)) add('the suite must run after the app server starts');
    if (!(result > suite && /EXPECTED_AUTH_SPECS/.test(String(steps[result]?.run)) && /EXPECTED_AUTH_TESTS/.test(String(steps[result]?.run)))) add('the exact suite result must be asserted after the suite');
    if (!(logScan > suite)) add('the app server log must be scanned for hosted targets after the suite');
    if (!(down > result)) add('teardown must come after the result checks');
    if (!/tee "\$RUNNER_TEMP\/auth-suite\.log"/.test(String(steps[suite]?.run))) add('the suite output must be captured for the result check');
    // Round 26 / C3 review C2: the rate-limit reset proves the identity marker before writing, on loopback
    // too; the marker must be seeded (per-run token via GITHUB_ENV) into the service container first.
    const seed = stepIndex(steps, /npm run seed:auth-e2e-redis-identity -- --env-out "\$GITHUB_ENV"/);
    const resetStep = stepIndex(steps, /npm run reset:auth-e2e-rate-limits/);
    if (!(seed >= 0 && resetStep > seed && server > resetStep)) add('the Redis identity marker must be seeded before the rate-limit reset, which must precede the app server');
  }
  return problems;
}

test('C3 workflow: every rule holds on the proposed workflow', () => {
  assert.deepEqual(checkWorkflow(SOURCE), []);
});

test('C3 workflow: the expected counts come from the real runner (5 spec files, one test each)', () => {
  assert.deepEqual(expectedAuthCounts(), { specs: 5, tests: 5 });
});

/**
 * Round 26 / C3 review C2 + re-review B-1: the hosted auth-integrity.yml is the reviewed f237b92f0 file plus
 * EXACTLY one step (seed the Redis identity marker), at the reviewed position. The base is PINNED by hash
 * (not compared with HEAD), so the check stays green once this change is committed and red on any other edit.
 */
const HOSTED_WORKFLOW_BASE_SHA256 = 'ce876600fc3c512ed07c2d75c76f6cec79d8b59731c46a87027bf14a476026ca'; // f237b92f0, LF-normalised
const HOSTED_SEED_STEP = [
  '      # Round 26 / C3 (review C2): the reset below writes only after reading the identity marker',
  '      # omnivyra:e2e:identity and finding it equal to a per-run token, on loopback too (a loopback',
  '      # port can be a tunnel to Production). This seeds the marker into the FRESH service container:',
  '      # the shared rule refuses production first, and only an EMPTY Redis (DBSIZE 0) is ever seeded.',
  '      # The random per-run token is masked and exported through GITHUB_ENV; it is never printed.',
  '      - name: Seed the disposable Redis identity marker (per-run token)',
  '        run: npm run seed:auth-e2e-redis-identity -- --env-out "$GITHUB_ENV"',
  '',
  '',
].join('\n');

function checkHostedWorkflow(raw: string): string[] {
  const problems: string[] = [];
  const text = raw.replace(/\r\n/g, '\n');
  const blocks = text.split(HOSTED_SEED_STEP).length - 1;
  const commands = text.split('seed:auth-e2e-redis-identity').length - 1;
  if (blocks !== 1 || commands !== 1) problems.push(`the seed step must appear exactly once (blocks ${blocks}, commands ${commands})`);
  const at = text.indexOf(HOSTED_SEED_STEP);
  const guard = text.indexOf('run: npm run check:auth-e2e-target');
  const health = text.indexOf('- name: Verify ephemeral Redis is healthy');
  const reset = text.indexOf('run: npm run reset:auth-e2e-rate-limits');
  const app = text.indexOf('run: |\n          npm run dev');
  if (!(at > guard && guard >= 0 && at > health && health >= 0 && reset > at && app > reset)) problems.push('the seed step must come after the target guard and the Redis health check, and before the reset and the app server');
  if (blocks === 1) {
    const base = text.replace(HOSTED_SEED_STEP, '');
    const digest = createHash('sha256').update(base).digest('hex');
    if (digest !== HOSTED_WORKFLOW_BASE_SHA256) problems.push('with the seed step removed the workflow is not the pinned reviewed base (another edit was made)');
  }
  return problems;
}

const HOSTED_WF = fs.readFileSync(path.join(WF_DIR, 'auth-integrity.yml'), 'utf8');

test('C3 workflow: the hosted auth-integrity.yml is the pinned reviewed base plus exactly the seed step, at the reviewed position', () => {
  assert.deepEqual(checkHostedWorkflow(HOSTED_WF), []);
  // The pin was computed from `git show f237b92f0:.github/workflows/auth-integrity.yml` (LF-normalised); it is not
  // recomputed here because CI checkouts are shallow (f237b92f0 is not available there).
  // CRLF checkouts are accepted (normalised).
  assert.deepEqual(checkHostedWorkflow(HOSTED_WF.replace(/\r?\n/g, '\r\n')), []);
});

test('C3 CONTROL hosted workflow: any other edit is detected', () => {
  const edited = HOSTED_WF.replace('run: npm run test:auth-integrity', 'run: npm run test:auth-integrity || true');
  assert.notEqual(edited, HOSTED_WF);
  assert.ok(checkHostedWorkflow(edited).some((p) => /pinned reviewed base/.test(p)));
  assert.ok(checkHostedWorkflow(HOSTED_WF + '# trailing edit\n').some((p) => /pinned reviewed base/.test(p)));
});

test('C3 CONTROL hosted workflow: a duplicated, removed or moved seed step is detected', () => {
  const lf = HOSTED_WF.replace(/\r\n/g, '\n');
  const dup = lf.replace(HOSTED_SEED_STEP, HOSTED_SEED_STEP + HOSTED_SEED_STEP);
  assert.ok(checkHostedWorkflow(dup).some((p) => /exactly once/.test(p)));
  const removed = lf.replace(HOSTED_SEED_STEP, '');
  assert.ok(checkHostedWorkflow(removed).some((p) => /exactly once/.test(p)));
  // Moved after the reset step.
  const resetStep = '      - name: Reset auth rate-limit counters\n        run: npm run reset:auth-e2e-rate-limits\n';
  assert.equal(removed.split(resetStep).length - 1, 1);
  const moved = removed.replace(resetStep, resetStep + '\n' + HOSTED_SEED_STEP.replace(/\n\n$/, '\n'));
  assert.ok(checkHostedWorkflow(moved).some((p) => /must come after the target guard/.test(p)), JSON.stringify(checkHostedWorkflow(moved)));
});

// ---------------- failing controls: each mutation must be detected ----------------
function expectDetected(label: string, from: string, to: string, problem: RegExp): void {
  assert.equal(SOURCE.split(from).length - 1, 1, `mutation anchor for "${label}" must occur exactly once`);
  const problems = checkWorkflow(SOURCE.replace(from, to));
  assert.ok(problems.some((p) => problem.test(p)), `${label}: expected a problem matching ${problem}, got ${JSON.stringify(problems)}`);
}

test('C3 CONTROL a hosted-E2E secret reference is detected', () => {
  expectDetected('secret', "OPENAI_API_KEY: e2e-placeholder-not-a-real-key", 'OPENAI_API_KEY: e2e-placeholder-not-a-real-key\n      E2E_SUPABASE_URL: ${{ secrets.E2E_SUPABASE_URL }}', /repository secret/);
});

test('C3 CONTROL a pull_request trigger is detected', () => {
  expectDetected('pull_request', 'on:\n  workflow_dispatch:', 'on:\n  pull_request:\n  workflow_dispatch:', /triggers must be exactly/);
});

test('C3 CONTROL teardown that does not always run is detected', () => {
  expectDetected('teardown', "      - name: Tear down the disposable stack\n        if: always()\n        run: bash tests/supabase-local/bootstrap.sh down\n\n      - name: Redact credentials from the evidence before upload\n        id: redact\n        if: always()\n        run: |", "      - name: Tear down the disposable stack\n        run: bash tests/supabase-local/bootstrap.sh down\n\n      - name: Redact credentials from the evidence before upload\n        id: redact\n        if: always()\n        run: |", /teardown must run if: always\(\)/);
});

test('C3 CONTROL a swallowed suite failure is detected', () => {
  expectDetected('|| true', 'run: npm run test:auth-integrity 2>&1 | tee "$RUNNER_TEMP/auth-suite.log"', 'run: npm run test:auth-integrity 2>&1 | tee "$RUNNER_TEMP/auth-suite.log" || true', /swallows failures/);
});

test('C3 CONTROL a missing exact-result assertion is detected', () => {
  expectDetected('result', 'assert-suite-result "$RUNNER_TEMP/auth-suite.log" "$EXPECTED_AUTH_SPECS" "$EXPECTED_AUTH_TESTS"', 'echo skipped-result-check', /exact suite result must be asserted/);
});

test('C3 CONTROL the prod-DB/local-Redis bypass flag is detected', () => {
  expectDetected('allow-prod', "AUTH_E2E_TIMEOUT_MS: '120000'", "AUTH_E2E_TIMEOUT_MS: '120000'\n      ALLOW_PROD_DB_WITH_LOCAL_REDIS: '1'", /ALLOW_PROD_DB_WITH_LOCAL_REDIS/);
});

test('C3 CONTROL a job name that reuses an existing (possibly required) context is detected', () => {
  expectDetected('name', 'name: Auth integrity regression suite (local Supabase, advisory)', 'name: Auth integrity regression lock', /reuses an existing job id or name/);
});

test('C3 CONTROL skipping the migration replay is detected', () => {
  expectDetected('baseline-only', 'run: bash tests/supabase-local/bootstrap.sh up --env-out "$GITHUB_ENV" 2>&1', 'run: bash tests/supabase-local/bootstrap.sh up --schema-mode baseline-only --env-out "$GITHUB_ENV" 2>&1', /skips migrations/);
});

test('C3 CONTROL starting the app before the hosted-target refusals is detected', () => {
  const server = '      - name: Start app server (against the local stack)';
  const refuse = '      - name: Refuse any hosted target (local mode only, no hosted marker in the environment)';
  const i = SOURCE.indexOf(refuse);
  const j = SOURCE.indexOf(server);
  const k = SOURCE.indexOf('      - name: Auth integrity regression suite (local)');
  assert.ok(i > 0 && j > i && k > j);
  const serverBlock = SOURCE.slice(j, k);
  const mutated = SOURCE.slice(0, i) + serverBlock + SOURCE.slice(i, j) + SOURCE.slice(k);
  assert.ok(checkWorkflow(mutated).some((p) => /refusals must precede the app server/.test(p)));
});

// ---------------- v3 controls (review findings F12, F17) ----------------
test('C3 CONTROL v3 a redaction step that does not always run is detected', () => {
  expectDetected('redact if', '      - name: Redact credentials from the evidence before upload\n        id: redact\n        if: always()\n        run: |', '      - name: Redact credentials from the evidence before upload\n        id: redact\n        run: |', /must redact credentials/);
});

test('C3 CONTROL v3 an uploaded log that is not redacted is detected', () => {
  expectDetected('unredacted log', 'redact-logs "$RUNNER_TEMP/bootstrap-up.log" "$RUNNER_TEMP/auth-suite.log" "$RUNNER_TEMP/auth-integrity-local-server.log"', 'redact-logs "$RUNNER_TEMP/bootstrap-up.log" "$RUNNER_TEMP/auth-suite.log"', /uploads auth-integrity-local-server\.log without redacting it/);
});

test('C3 CONTROL v3 uploading the browser storage state is detected', () => {
  expectDetected('storage state', '            !test-results/auth-integrity/**/storage-state.json\n', '', /browser storage state/);
});

test('C3 CONTROL v3 an offline spec dropped from the CI unit step is detected', () => {
  expectDetected('dropped spec', ' tests/supabase-local/bootstrapSimulation.spec.ts', '', /bootstrapSimulation\.spec\.ts is not run/);
});

test('C3 CONTROL v3.1 R2 an upload that ignores the redaction outcome is detected', () => {
  const first = "        if: always() && steps.redact.outcome == 'success'\n        uses: actions/upload-artifact@v4\n        with:\n          name: local-stack-validation";
  assert.equal(SOURCE.split(first).length - 1, 1);
  const problems = checkWorkflow(SOURCE.replace(first, "        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n          name: local-stack-validation"));
  assert.ok(problems.some((p) => /upload must require a successful redaction/.test(p)), JSON.stringify(problems));
});

test('C3 CONTROL review C2 a missing identity-marker seed step is detected', () => {
  expectDetected('no seed', 'run: npm run seed:auth-e2e-redis-identity -- --env-out "$GITHUB_ENV"', 'run: echo skipped-seed', /identity marker must be seeded/);
});
