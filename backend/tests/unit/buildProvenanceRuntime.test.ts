/**
 * Build provenance at RUNTIME (round 12): what `emitBootFingerprint()` and
 * `GET /api/health/version` report for the source commit.
 *
 * The build-time RESULT (`generated/build-provenance/result.json`, gitignored,
 * written by safe-build) is always supplied by a virtual mock, so a result left
 * on a developer's disk by a local build cannot change these tests.
 *
 * Failing controls against 2bc52db7a (recorded in the round-12 report):
 *  - redeploy-equivalent (stamp present, env empty): the old route served
 *    `build: null` because it read only env.
 *  - "no fabricated fallback": the old route served RAILWAY_DEPLOYMENT_ID as
 *    `build`, a deployment id posing as a commit.
 *  - every `build_provenance` / `commit_sha` / `deployment_id` assertion: those
 *    fields did not exist.
 */
import type { NextApiRequest, NextApiResponse } from 'next';

/* eslint-disable @typescript-eslint/no-var-requires */
const RESULT = '../../../generated/build-provenance/result.json';
const SHA = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST = 'd'.repeat(64);

const env = process.env as Record<string, string | undefined>;
const KEYS = ['VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'GIT_COMMIT_SHA', 'VERCEL_DEPLOYMENT_ID', 'RAILWAY_DEPLOYMENT_ID'];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = env[k]; delete env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; } });

const verified = (over: Record<string, unknown> = {}) => ({
  schema_version: 1, status: 'verified', reason: 'stamp_matches_built_source',
  commit_sha: SHA, tree_sha: 'c'.repeat(40), source_digest: DIGEST, file_count: 3,
  checked_file_count: 3, build_deployment_id: null, built_at: 'T', ...over,
});

function notFound(): never {
  const e: any = new Error(`Cannot find module '${RESULT}'`);
  e.code = 'MODULE_NOT_FOUND';
  throw e;
}

/** A fresh "instance": new module registry, the given build result, quiet logger. */
function instance(result: unknown | typeof notFound) {
  jest.resetModules();
  jest.doMock(RESULT, () => (result === notFound ? notFound() : result), { virtual: true });
  jest.doMock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
  let mods: any;
  jest.isolateModules(() => {
    mods = {
      fp: require('../../security/startup/bootFingerprint'),
      version: require('../../../pages/api/health/version').default,
    };
  });
  return mods;
}

function resDouble() {
  const out: { status: number | null; body: any } = { status: null, body: undefined };
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    end() { return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
    getHeader(k: string) { return headers[k]; },
    get headersSent() { return false; },
  } as unknown as NextApiResponse;
  return { res, out };
}
const getReq = () => ({ method: 'GET', headers: {}, query: {}, cookies: {} }) as unknown as NextApiRequest;

async function versionBody(result: unknown) {
  const m = instance(result);
  const { res, out } = resDouble();
  await m.version(getReq(), res);
  expect(out.status).toBe(200);
  return out.body;
}

describe('resolveBuildProvenance (pure)', () => {
  const resolve = (r: unknown, e: Record<string, string>) =>
    require('../../security/startup/buildProvenance').resolveBuildProvenance(r, e);

  it('normal: verified stamp + agreeing env -> verified', () => {
    expect(resolve(verified(), { VERCEL_GIT_COMMIT_SHA: SHA })).toMatchObject({ status: 'verified', commitSha: SHA, source: 'stamp' });
  });

  it('env DISAGREES with a verified stamp -> unverified, commit withheld', () => {
    const p = resolve(verified(), { VERCEL_GIT_COMMIT_SHA: SHA_B });
    expect(p).toMatchObject({ status: 'unverified', reason: 'env_commit_disagrees_with_stamp', commitSha: null, claimedCommitSha: SHA });
  });

  it('result built for ANOTHER deployment -> unverified', () => {
    const p = resolve(verified({ build_deployment_id: 'dpl_old' }), { VERCEL_DEPLOYMENT_ID: 'dpl_new' });
    expect(p).toMatchObject({ status: 'unverified', reason: 'build_result_from_other_deployment', commitSha: null });
    // control: same deployment -> verified
    expect(resolve(verified({ build_deployment_id: 'dpl_new' }), { VERCEL_DEPLOYMENT_ID: 'dpl_new' }).status).toBe('verified');
  });

  it('env only (no result) -> unverified claim, never verified', () => {
    expect(resolve(null, { VERCEL_GIT_COMMIT_SHA: SHA })).toMatchObject({ status: 'unverified', commitSha: null, claimedCommitSha: SHA, source: 'env' });
  });

  it('malformed env claim is not echoed as a commit', () => {
    expect(resolve(null, { GIT_COMMIT_SHA: 'main' })).toMatchObject({ status: 'unverified', reason: 'env_commit_malformed', claimedCommitSha: null });
  });

  it('a verified-looking result with a malformed sha or digest is not verified', () => {
    expect(resolve(verified({ commit_sha: 'HEAD' }), {}).status).toBe('unverified');
    expect(resolve(verified({ source_digest: '2026-11-26T00:00:00.000Z' }), {}).status).toBe('unverified');
    expect(resolve(verified({ schema_version: 9 }), {}).status).toBe('unverified');
    expect(resolve(verified({ status: 'VERIFIED' }), {}).status).toBe('unverified');
    expect(resolve('verified', {}).status).toBe('missing');
  });
});

describe('GET /api/health/version build identity', () => {
  it('normal stamp: build == commit_sha == the stamped commit, verified', async () => {
    env.VERCEL_GIT_COMMIT_SHA = SHA;
    const b = await versionBody(verified());
    expect(b).toMatchObject({ build: SHA, commit_sha: SHA, build_provenance: 'verified', build_provenance_source: 'stamp' });
  });

  it('THE BUG: REDEPLOY-equivalent (stamp present, VERCEL_GIT_COMMIT_SHA empty) still reports the commit', async () => {
    env.VERCEL_GIT_COMMIT_SHA = '';
    const b = await versionBody(verified());
    expect(b.build).toBe(SHA);
    expect(b.build_provenance).toBe('verified');
  });

  it('missing stamp AND env -> build null, build_provenance missing, with a reason', async () => {
    env.VERCEL_GIT_COMMIT_SHA = '';
    const b = await versionBody(notFound);
    expect(b.build).toBeNull();
    expect(b.commit_sha).toBeNull();
    expect(b.build_provenance).toBe('missing');
    expect(typeof b.build_provenance_reason).toBe('string');
    expect(b.build_provenance_reason.length).toBeGreaterThan(0);
  });

  it('INVALID stamp (bad sha format) -> build null, unverified', async () => {
    const b = await versionBody({ ...verified({ status: 'unverified', reason: 'stamp_commit_sha_malformed', commit_sha: null }) });
    expect(b).toMatchObject({ build: null, build_provenance: 'unverified', build_provenance_reason: 'build:stamp_commit_sha_malformed', claimed_commit_sha: null });
  });

  it('STALE stamp (digest mismatch at build) is NOT verified, even when env agrees', async () => {
    env.VERCEL_GIT_COMMIT_SHA = SHA;
    const b = await versionBody(verified({ status: 'unverified', reason: 'source_content_mismatch' }));
    expect(b.build).toBeNull();
    expect(b.build_provenance).toBe('unverified');
    expect(b.claimed_commit_sha).toBe(SHA);
  });

  it('NO FABRICATED FALLBACK: a Railway deployment id is never reported as the build commit', async () => {
    env.VERCEL_GIT_COMMIT_SHA = '';
    env.RAILWAY_DEPLOYMENT_ID = 'railway-deploy-1';
    const b = await versionBody(notFound);
    expect(b.build).toBeNull();
    expect(b.commit_sha).toBeNull();
    expect(b.claimed_commit_sha).toBeNull();
    expect(b.deployment_id).toBe('railway-deploy-1');
  });

  it('deployment id and commit are reported SEPARATELY', async () => {
    env.VERCEL_DEPLOYMENT_ID = 'dpl_5nmFWHfujyNu8UJV59qaXP1cN1Dq';
    const b = await versionBody(verified());
    expect(b.commit_sha).toBe(SHA);
    expect(b.deployment_id).toBe('dpl_5nmFWHfujyNu8UJV59qaXP1cN1Dq');
    expect(b.deployment_id).not.toBe(b.commit_sha);
  });

  it('the version payload carries the documented provenance keys', async () => {
    const b = await versionBody(verified());
    for (const k of ['build', 'commit_sha', 'claimed_commit_sha', 'build_provenance', 'build_provenance_reason',
      'build_provenance_source', 'deployment_id', 'schema_manifest_hash', 'schema_manifest_status']) {
      expect(b).toHaveProperty(k);
    }
  });

  it('the fingerprint snapshot cannot be mutated by a caller', () => {
    const m = instance(verified());
    const snap = m.fp.emitBootFingerprint();
    const p = require('../../security/startup/buildProvenance');
    expect(Object.isFrozen(p.getSchemaManifestIdentity())).toBe(true);
    expect(snap.commitSha).toBe(SHA);
  });
});
