/**
 * No production db push (b3/owner, 2026-11-21): three layers, each with controls.
 *  1. scripts/guard-no-prod-push.sh refuses any target that COULD be production: the prod ref in the args or the
 *     connection env, or a LINKED prod project when no explicit target is given (the hole in the old args-only guard).
 *     It passes only a target proven non-production.
 *  2. scripts/operator/db/db-push.sh refuses --target-env=production outright, with no override flag.
 *  3. scripts/ci/check-no-raw-db-push.js fails CI on a direct `supabase db push` / `migration up` INVOCATION outside
 *     the wrapper, while messages that merely NAME the command pass.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.join(__dirname, '../../..');
const GUARD = path.join(REPO, 'scripts/guard-no-prod-push.sh');
const GATE = path.join(REPO, 'scripts/ci/check-no-raw-db-push.js');
const PROD = 'klkiseupptzbecbxwrky';
const OTHER = 'abcdefghijklmnopqrst';
const CLEAN_ENV = { ...process.env, SUPABASE_DB_URL: '', DATABASE_URL: '', SUPABASE_PROJECT_REF: '', SUPABASE_PROJECT_ID: '' };

function root(link?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nopush-'));
  if (link !== undefined) {
    fs.mkdirSync(path.join(dir, 'supabase/.temp'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'supabase/.temp/project-ref'), link);
  }
  return dir;
}
const guard = (args: string[], opts: { link?: string; env?: Record<string, string> } = {}) =>
  spawnSync('bash', [GUARD, ...args], { encoding: 'utf8', env: { ...CLEAN_ENV, GUARD_ROOT: root(opts.link), ...(opts.env || {}) } });

describe('guard-no-prod-push.sh: refuses anything that could be production', () => {
  it('refuses the prod ref in the arguments (--project-ref X and --project-ref=X)', () => {
    expect(guard(['--project-ref', PROD]).status).toBe(1);
    expect(guard([`--project-ref=${PROD}`]).status).toBe(1);
  });
  it('refuses a prod --db-url and a prod connection env var', () => {
    expect(guard([`--db-url=postgres://u:p@db.${PROD}.supabase.co:5432/postgres`]).status).toBe(1);
    expect(guard([], { link: OTHER, env: { SUPABASE_DB_URL: `postgres://db.${PROD}.supabase.co` } }).status).toBe(1);
  });
  it('THE HOLE: no target in the args but the checkout is LINKED to prod -> refused (the old guard passed this)', () => {
    const r = guard([], { link: PROD });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('LINKED to the production project');
  });
  it('refuses when the target is not determinable (no args, no link) and when the link file is empty', () => {
    expect(guard([]).status).toBe(1);
    expect(guard([], { link: '' }).status).toBe(1);
  });
  it('refuses a non-local --db-url (not provably non-production)', () => {
    expect(guard(['--db-url', 'postgres://u:p@some-remote-host:5432/postgres']).status).toBe(1);
  });
  it('CONTROLS: proven non-production targets pass', () => {
    expect(guard(['--local']).status).toBe(0);
    expect(guard(['--db-url', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres']).status).toBe(0);
    expect(guard([`--db-url=postgresql://postgres@localhost:54322/postgres`]).status).toBe(0);
    expect(guard(['--project-ref', OTHER]).status).toBe(0);
    expect(guard([], { link: OTHER }).status).toBe(0);
  });
});

describe('db-push.sh: production is never a db push target', () => {
  it('refuses --target-env=production even with every old override flag (exit 1, before any CLI call)', () => {
    const r = spawnSync('bash', ['scripts/operator/db/db-push.sh', '--target-env=production', '--apply',
      '--confirm-production-impact', '--acknowledge-ledger-desync'], { cwd: REPO, encoding: 'utf8', env: CLEAN_ENV });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('target-env=production is never a db push target');
  });
  it('CONTROL: a local target without --apply stops at the intent check (exit 0, nothing run)', () => {
    const r = spawnSync('bash', ['scripts/operator/db/db-push.sh', '--target-env=local'], { cwd: REPO, encoding: 'utf8', env: CLEAN_ENV });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Missing explicit mutation intent flag');
  });
});

describe('check-no-raw-db-push.js: no direct CLI invocation outside the wrapper', () => {
  function repo(files: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nopush-gate-'));
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    return spawnSync(process.execPath, [GATE, '--root', dir], { encoding: 'utf8' });
  }
  const base = { 'package.json': JSON.stringify({ scripts: { 'db:push': 'bash ./scripts/operator/db/db-push.sh' } }) };
  it.each([
    ['a shell line', { 'scripts/x.sh': 'set -e\nsupabase db push --linked\n' }],
    ['after &&', { 'scripts/x.sh': 'cd x && npx supabase migration up\n' }],
    ['a workflow run:', { '.github/workflows/x.yml': 'steps:\n  - run: npx supabase db push\n' }],
    ['a JS exec string', { 'scripts/x.js': "require('child_process').execSync('supabase db push --linked');\n" }],
    ['a JS spawn argv', { 'scripts/x.js': "spawnSync('supabase', ['db', 'push']);\n" }],
    ['an npm script', { 'package.json': JSON.stringify({ scripts: { 'yolo': 'supabase db push' } }) }],
    // 7c reach finding: operational scripts also live outside scripts/**.
    ['backend/scripts (JS exec)', { 'backend/scripts/push-schema.ts': "execSync('npx supabase db push');\n" }],
    ['tools/ (shell)', { 'tools/x.sh': 'supabase migration up\n' }],
    ['a root Dockerfile RUN', { 'Dockerfile.cron': 'FROM node:20\nRUN npx supabase db push --linked\n' }],
    ['a root *.sh', { 'deploy.sh': 'set -e\nsupabase db push\n' }],
  ])('FAILS on %s', (_n, files) => {
    const r = repo({ ...base, ...files });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL');
  });
  it('CONTROLS: messages and comments that NAME the command pass; the sanctioned wrapper passes', () => {
    const r = repo({
      ...base,
      'scripts/a.js': "console.log('*** DO NOT RUN `supabase db push` ***');\n// supabase db push is unsafe\n",
      'scripts/b.sh': '# never run supabase db push here\necho "supabase db push is refused"\n',
      'scripts/operator/db/db-push.sh': 'supabase db push "${FILTERED_ARGS[@]}"\n',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });
  it('NO VACUOUS PASS: an empty tree refuses (exit 2)', () => {
    expect(spawnSync(process.execPath, [GATE, '--root', fs.mkdtempSync(path.join(os.tmpdir(), 'nopush-empty-'))], { encoding: 'utf8' }).status).toBe(2);
  });
});
