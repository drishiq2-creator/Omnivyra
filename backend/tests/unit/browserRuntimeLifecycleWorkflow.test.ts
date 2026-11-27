/**
 * Safety and shape of the browser-runtime soak: the CI workflow, the harness,
 * and the worker image it runs in. Hermetic: reads files from disk only.
 */
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load(source: string): any };

const REPO = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const WF_PATH = '.github/workflows/browser-runtime-lifecycle.yml';

describe('browser-runtime-lifecycle workflow', () => {
  const src = read(WF_PATH);
  const wf = yaml.load(src);

  it('triggers only on manual dispatch and ci-only/browser-runtime/** pushes', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(wf.on.push).toEqual({ branches: ['ci-only/browser-runtime/**'] });
    expect(wf.on.pull_request).toBeUndefined();
    expect(wf.on.pull_request_target).toBeUndefined();
  });

  it('references no secret and only reads the repository', () => {
    expect(src).not.toMatch(/secrets\./);
    expect(wf.permissions).toEqual({ contents: 'read' });
    const checkout = wf.jobs.lifecycle.steps.find((s: any) => String(s.uses || '').startsWith('actions/checkout@'));
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('every container runs with --network none (through the shared LIMITS)', () => {
    const limits: string = wf.jobs.lifecycle.env.LIMITS;
    expect(limits.split(/\s+/)).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(limits).toMatch(/--pids-limit=\d+/);
    expect(limits).toMatch(/--memory=\S+/);
    const runs = wf.jobs.lifecycle.steps.map((s: any) => String(s.run || '')).join('\n');
    const dockerRuns = runs.split('\n').filter((l: string) => /\bdocker run\b/.test(l));
    expect(dockerRuns.length).toBeGreaterThanOrEqual(2);
    for (const l of dockerRuns) expect(l).toContain('$LIMITS');
  });

  it('runs the A/B variants and the verdict step', () => {
    for (const v of ['no-init', 'tini', 'docker-init', 'shm-small', 'shm-small-noflag']) {
      expect(src).toContain(`--variant=${v} `);
    }
    expect(src).toMatch(/run_variant docker-init --init --entrypoint node/);
    expect(src).toMatch(/run_variant no-init --entrypoint node/);
    expect(src).toContain('--drop-arg=--disable-dev-shm-usage');
    expect(src).toContain('node scripts/browser-runtime/compare-variants.js out');
  });

  it('CONTROL: the trigger assertion would catch a pull_request trigger', () => {
    const tampered = yaml.load(src.replace('on:\n', 'on:\n  pull_request:\n'));
    expect(Object.keys(tampered.on).sort()).not.toEqual(['push', 'workflow_dispatch']);
  });
});

describe('lifecycle-soak harness guards', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const harness = require(path.join(REPO, 'scripts/browser-runtime/lifecycle-soak.js'));

  it('treats only http(s)://127.0.0.1 as loopback', () => {
    expect(harness.isLoopbackUrl('http://127.0.0.1:1234/')).toBe(true);
    for (const u of ['http://localhost/', 'https://www.linkedin.com/', 'http://127.0.0.1.nip.io/', 'http://blocked.invalid/']) {
      expect(harness.isLoopbackUrl(u)).toBe(false);
    }
  });

  it('launches with a dead proxy and a route allowlist', () => {
    const src = read('scripts/browser-runtime/lifecycle-soak.js');
    expect(src).toContain("const DEAD_PROXY = { server: 'http://127.0.0.1:9', bypass: '127.0.0.1' };");
    expect(src).toContain("await context.route('**/*'");
    expect(src).toContain("const BLOCKED_URL = 'http://blocked.invalid/';");
  });
});

describe('Dockerfile.worker runtime', () => {
  const lines = read('Dockerfile.worker').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const prodStage = lines.slice(lines.findIndex((l) => /^FROM .* AS production$/i.test(l)));

  it('the production stage installs tini and uses it as PID 1', () => {
    expect(prodStage.some((l) => /apt-get install .*\btini\b/.test(l))).toBe(true);
    expect(prodStage).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(prodStage[prodStage.length - 1]).toBe('CMD ["node", "dist/backend/workers/main.js"]');
  });

  it('declares itself the browser runtime', () => {
    expect(prodStage).toContain('ENV OMNIVYRA_BROWSER_RUNTIME=worker');
  });

  it('keeps the Playwright Chromium install unchanged', () => {
    expect(prodStage).toContain('RUN npx playwright install --with-deps chromium \\');
  });
});
