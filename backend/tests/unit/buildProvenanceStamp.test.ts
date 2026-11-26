/**
 * Build provenance, deploy-time STAMP and build-time VERIFY (round 12).
 *
 * Covers the pure core (`backend/security/startup/buildProvenanceStamp.js`) and
 * the deploy script's refusal / stamp / cleanup flow (`scripts/vercel-deploy-
 * prod.js` `main(deps)`), driven with a FAKE git and a FAKE vercel. The real
 * vercel CLI is never invoked: every test passes `runVercel`.
 *
 * Failing control (2bc52db7a): neither the core module nor the script's exports
 * exist there, and the old script RUNS on require (git + vercel + process.exit),
 * so it must never be required by a test. The `exports-only` pin below fails
 * first against that file WITHOUT requiring it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/* eslint-disable @typescript-eslint/no-var-requires */
const REPO = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'vercel-deploy-prod.js');

const SHA = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TREE = 'c'.repeat(40);

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-prov-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function write(rel: string, body: string) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

function core() {
  return require('../../security/startup/buildProvenanceStamp');
}

function stampFor(files: Record<string, string>) {
  const c = core();
  for (const [k, v] of Object.entries(files)) write(k, v);
  return c.buildStamp({
    commitSha: SHA, treeSha: TREE, clean: true,
    files: c.hashFiles(tmp, Object.keys(files)), stampedAt: '2026-11-26T00:00:00.000Z',
  });
}

describe('core: upload list and stamp construction', () => {
  it('uploadableFiles removes exactly the ignored tracked files and sorts', () => {
    const c = core();
    expect(c.uploadableFiles('b.ts\0a.ts\0.gitignore\0x/node_modules/y.js\0', '.gitignore\0x/node_modules/y.js\0'))
      .toEqual(['a.ts', 'b.ts']);
    // control: with nothing ignored, everything stays
    expect(c.uploadableFiles('b.ts\0a.ts\0', '')).toEqual(['a.ts', 'b.ts']);
  });

  it('digest is order-independent and changes when any hash changes', () => {
    const c = core();
    const h = sha256('x');
    expect(c.digestFileMap({ a: h, b: h })).toBe(c.digestFileMap({ b: h, a: h }));
    expect(c.digestFileMap({ a: h, b: h })).not.toBe(c.digestFileMap({ a: h, b: sha256('y') }));
  });

  it('REFUSES to stamp a dirty tree, a malformed sha, or nothing', () => {
    const c = core();
    const files = { 'a.ts': sha256('a') };
    expect(() => c.buildStamp({ commitSha: SHA, treeSha: TREE, clean: false, files, stampedAt: 't' })).toThrow(/not clean/);
    expect(() => c.buildStamp({ commitSha: 'abc', treeSha: TREE, clean: true, files, stampedAt: 't' })).toThrow(/40 hex/);
    expect(() => c.buildStamp({ commitSha: SHA, treeSha: '', clean: true, files, stampedAt: 't' })).toThrow(/tree sha/);
    expect(() => c.buildStamp({ commitSha: SHA, treeSha: TREE, clean: true, files: {}, stampedAt: 't' })).toThrow(/no files/);
    // control: the same inputs, clean, DO stamp
    expect(c.buildStamp({ commitSha: SHA, treeSha: TREE, clean: true, files, stampedAt: 't' }).commit_sha).toBe(SHA);
  });
});

describe('core: verifyStamp (what the BUILD decides)', () => {
  it('normal stamp: every listed file matches -> verified', () => {
    const st = stampFor({ 'a.ts': 'A', 'dir/b.ts': 'B' });
    const v = core().verifyStamp(st, tmp);
    expect(v.status).toBe('verified');
    expect(v.commit_sha).toBe(SHA);
    expect(v.checked_file_count).toBe(2);
  });

  it('STALE stamp: one file changed after stamping -> unverified, never verified', () => {
    const st = stampFor({ 'a.ts': 'A', 'dir/b.ts': 'B' });
    write('dir/b.ts', 'B-changed');
    const v = core().verifyStamp(st, tmp);
    expect(v.status).toBe('unverified');
    expect(v.reason).toBe('source_content_mismatch');
    expect(v.sample).toEqual(['dir/b.ts']);
    // the claim is still reported, as a claim
    expect(v.commit_sha).toBe(SHA);
  });

  it('a listed file missing from the build -> unverified', () => {
    const st = stampFor({ 'a.ts': 'A', 'b.ts': 'B' });
    fs.unlinkSync(path.join(tmp, 'b.ts'));
    const v = core().verifyStamp(st, tmp);
    expect(v).toMatchObject({ status: 'unverified', reason: 'source_file_missing', missing_count: 1 });
  });

  it('INVALID stamp: bad sha format -> unverified with no claimed commit', () => {
    const st = { ...stampFor({ 'a.ts': 'A' }), commit_sha: 'HEAD' };
    const v = core().verifyStamp(st, tmp);
    expect(v).toMatchObject({ status: 'unverified', reason: 'stamp_commit_sha_malformed', commit_sha: null });
  });

  it('INVALID stamp: wrong digest (file map edited) -> unverified', () => {
    const st = stampFor({ 'a.ts': 'A' });
    st.files['a.ts'] = sha256('something else');
    // keep file_count consistent so the DIGEST is what catches it
    expect(core().verifyStamp(st, tmp).reason).toBe('stamp_digest_mismatch');
  });

  it('INVALID stamp: clean flag false, schema bump, path traversal, count drift', () => {
    const c = core();
    const st = stampFor({ 'a.ts': 'A' });
    expect(c.verifyStamp({ ...st, clean: false }, tmp).reason).toBe('stamp_not_clean');
    expect(c.verifyStamp({ ...st, schema_version: 2 }, tmp).reason).toBe('stamp_schema_version_unsupported');
    expect(c.verifyStamp({ ...st, file_count: 2 }, tmp).reason).toBe('stamp_file_count_mismatch');
    const evil = { ...st, files: { '../outside.ts': sha256('A') } };
    expect(c.verifyStamp({ ...evil, source_digest: c.digestFileMap(evil.files) }, tmp).reason).toBe('stamp_path_outside_root');
    expect(c.verifyStamp(null, tmp).status).toBe('unverified');
    expect(c.verifyStamp([], tmp).status).toBe('unverified');
  });
});

describe('core: runBuildVerify (safe-build step)', () => {
  const resultPath = () => path.join(tmp, 'generated', 'build-provenance', 'result.json');
  const readResult = () => JSON.parse(fs.readFileSync(resultPath(), 'utf8'));

  it('no stamp -> result status missing (and no commit is invented)', () => {
    const r = core().runBuildVerify({ root: tmp, env: {}, now: () => 'T' });
    expect(r).toMatchObject({ status: 'missing', commit_sha: null });
    expect(readResult()).toEqual(r);
  });

  it('a STALE verified result left on disk is replaced, never reused', () => {
    write('generated/build-provenance/result.json', JSON.stringify({ schema_version: 1, status: 'verified', commit_sha: SHA }));
    const r = core().runBuildVerify({ root: tmp, env: {}, now: () => 'T' });
    expect(r.status).toBe('missing');
    expect(readResult().status).toBe('missing');
  });

  it('stamp present and matching -> verified, with the build deployment id recorded', () => {
    const st = stampFor({ 'a.ts': 'A' });
    write('generated/build-provenance/stamp.json', JSON.stringify(st));
    const r = core().runBuildVerify({ root: tmp, env: { VERCEL_DEPLOYMENT_ID: 'dpl_1' }, now: () => 'T' });
    expect(r).toMatchObject({ status: 'verified', commit_sha: SHA, build_deployment_id: 'dpl_1', file_count: 1 });
    // the runtime-facing result never carries the file list
    expect(r).not.toHaveProperty('files');
  });

  it('REDEPLOY-equivalent: the same uploaded files rebuilt with no env -> still verified', () => {
    const st = stampFor({ 'a.ts': 'A', 'b.ts': 'B' });
    write('generated/build-provenance/stamp.json', JSON.stringify(st));
    const first = core().runBuildVerify({ root: tmp, env: {}, now: () => 'T1' });
    const second = core().runBuildVerify({ root: tmp, env: {}, now: () => 'T2' });
    expect(first.status).toBe('verified');
    expect(second.status).toBe('verified');
    expect(second.commit_sha).toBe(first.commit_sha);
  });

  it('unparseable stamp -> unverified', () => {
    write('generated/build-provenance/stamp.json', '{not json');
    expect(core().runBuildVerify({ root: tmp, env: {}, now: () => 'T' })).toMatchObject({ status: 'unverified', reason: 'stamp_unparseable' });
  });

  it('a stale result that cannot be deleted FAILS the step (throws), never survives', () => {
    const c = core();
    const fakeFs = { ...fs, unlinkSync: () => { const e: any = new Error('EPERM'); e.code = 'EPERM'; throw e; } };
    expect(() => c.runBuildVerify({ root: tmp, env: {}, fsImpl: fakeFs, now: () => 'T' })).toThrow(/EPERM/);
  });
});

describe('deploy script: refusal, stamp, cleanup (fake git, fake vercel)', () => {
  it('pin: the script only EXPORTS on require; it runs main() only when executed', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/if \(require\.main === module\)/);
    expect(src).toMatch(/module\.exports = \{/);
  });

  const script = () => {
    // Guarded by the pin above: never require a version that executes on load.
    if (!/if \(require\.main === module\)/.test(fs.readFileSync(SCRIPT, 'utf8'))) throw new Error('script executes on require');
    return require(SCRIPT);
  };

  function fakeGit(over: Partial<Record<string, string | (() => string)>> = {}) {
    const calls: string[] = [];
    const table: Record<string, string | (() => string)> = {
      'rev-parse HEAD': SHA,
      'rev-parse "HEAD^{tree}"': TREE,
      'status --porcelain': '',
      'ls-files -z': 'a.ts\0b.ts\0.gitignore\0',
      ...over,
    };
    const git = (cmd: string) => {
      calls.push(cmd);
      if (cmd.startsWith('ls-files -z --cached --ignored')) {
        const v = table.__ignored ?? '.gitignore\0';
        return typeof v === 'function' ? v() : v;
      }
      const v = table[cmd];
      if (v === undefined) throw new Error(`unexpected git ${cmd}`);
      return typeof v === 'function' ? v() : v;
    };
    return { git, calls };
  }

  const stampAbs = () => path.join(tmp, 'generated', 'build-provenance', 'stamp.json');
  const resultAbs = () => path.join(tmp, 'generated', 'build-provenance', 'result.json');

  function base(gitOver = {}, runVercel = jest.fn()) {
    write('a.ts', 'A'); write('b.ts', 'B'); write('.gitignore', 'x');
    const g = fakeGit(gitOver);
    const errs: string[] = [];
    const deps = { root: tmp, git: g.git, runVercel, stdout: () => {}, stderr: (s: string) => errs.push(s), now: () => 'T', argv: [] };
    return { deps, runVercel, errs, calls: g.calls };
  }

  it('DIRTY tree -> refuses, writes no stamp, never calls vercel', () => {
    const { deps, runVercel, errs } = base({ 'status --porcelain': ' M a.ts' });
    expect(script().main(deps)).toBe(1);
    expect(errs.join('')).toMatch(/working tree is not clean/);
    expect(runVercel).not.toHaveBeenCalled();
    expect(fs.existsSync(stampAbs())).toBe(false);
  });

  it('malformed HEAD -> refuses before anything else', () => {
    const { deps, runVercel } = base({ 'rev-parse HEAD': 'deadbeef' });
    expect(script().main(deps)).toBe(1);
    expect(runVercel).not.toHaveBeenCalled();
  });

  it('happy path: a VERIFIABLE stamp exists while vercel runs, -e cross-check passed, stamp deleted after', () => {
    let seen: any = null;
    const runVercel = jest.fn((args: string[]) => {
      seen = { args, stamp: JSON.parse(fs.readFileSync(stampAbs(), 'utf8')), resultPresent: fs.existsSync(resultAbs()) };
    });
    const { deps } = base({}, runVercel);
    write('generated/build-provenance/result.json', '{"status":"verified"}'); // stale local build output
    expect(script().main(deps)).toBe(0);
    expect(runVercel).toHaveBeenCalledTimes(1);
    expect(seen.args).toEqual(expect.arrayContaining(['--prod', '-e', `VERCEL_GIT_COMMIT_SHA=${SHA}`]));
    expect(seen.resultPresent).toBe(false); // stale result never rides the upload
    expect(seen.stamp.commit_sha).toBe(SHA);
    expect(Object.keys(seen.stamp.files).sort()).toEqual(['a.ts', 'b.ts']); // .gitignore excluded (Vercel default)
    expect(core().verifyStamp(seen.stamp, tmp).status).toBe('verified');
    expect(fs.existsSync(stampAbs())).toBe(false);
  });

  it('vercel FAILS -> non-zero exit and the stamp is still deleted', () => {
    const runVercel = jest.fn(() => { const e: any = new Error('boom'); e.status = 3; throw e; });
    const { deps } = base({}, runVercel);
    expect(script().main(deps)).toBe(3);
    expect(fs.existsSync(stampAbs())).toBe(false);
  });

  it('stamp NOT gitignored (tree dirty after stamping) -> refuses, deletes stamp, no vercel', () => {
    let n = 0;
    const { deps, runVercel, errs } = base({ 'status --porcelain': () => (n++ === 0 ? '' : '?? generated/build-provenance/') });
    expect(script().main(deps)).toBe(1);
    expect(errs.join('')).toMatch(/not gitignored|tree changed/);
    expect(runVercel).not.toHaveBeenCalled();
    expect(fs.existsSync(stampAbs())).toBe(false);
  });

  it('HEAD moves while stamping -> refuses', () => {
    let n = 0;
    const { deps, runVercel } = base({ 'rev-parse HEAD': () => (n++ === 0 ? SHA : SHA_B) });
    expect(script().main(deps)).toBe(1);
    expect(runVercel).not.toHaveBeenCalled();
    expect(fs.existsSync(stampAbs())).toBe(false);
  });

  it('the ignored-file query uses .vercelignore AND the Vercel defaults', () => {
    const args = script().ignoredListArgs();
    expect(args).toEqual(expect.arrayContaining(['--exclude-from=.vercelignore', '--exclude=.gitignore', '--exclude=node_modules', '--exclude=__pycache__']));
  });
});
