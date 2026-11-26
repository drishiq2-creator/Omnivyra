/**
 * Schema manifest hash (round 12): one authoritative source, deterministic,
 * independent of which route an instance serves first, never a timestamp, and
 * distinct from runtime readiness.
 *
 * Each "instance" is a fresh module registry (`jest.resetModules` +
 * `jest.isolateModules`), which is what a new serverless instance is: the
 * fingerprint cache starts empty and the FIRST route decides what is cached.
 *
 * Failing controls against 2bc52db7a (recorded in the round-12 report):
 *  - readiness-first: authSubsystemBoot passed `schema.checkedAt` (an ISO
 *    timestamp, > 16 chars) as the manifest "hint", so the instance cached a
 *    TIMESTAMP as schema_manifest_hash, and version then served it.
 *  - missing / invalid manifest: the old code read the file with fs via
 *    `__dirname`, so a module-level manifest change was not seen at all, and
 *    there was no status field.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

/* eslint-disable @typescript-eslint/no-var-requires */
const MANIFEST = '../../../generated/schema-column-manifest.json';
const RESULT = '../../../generated/build-provenance/result.json';
const COMMITTED = JSON.parse(fs.readFileSync(path.join(__dirname, MANIFEST), 'utf8'));
const COMMITTED_HASH: string = COMMITTED.manifest_hash;
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const CHECKED_AT = '2026-11-26T06:59:20.200Z';

/** Same rows->hash rule as scripts/generate-schema-manifest.js `hashManifest`. */
function rowsHash(columns: Array<{ table: string; column: string; source_migration: string }>): string {
  const t = new Map<string, Map<string, string>>();
  for (const c of columns) { if (!t.has(c.table)) t.set(c.table, new Map()); t.get(c.table)!.set(c.column, c.source_migration); }
  const e: string[] = [];
  for (const [table, cols] of [...t.entries()].sort()) for (const [col, src] of [...cols.entries()].sort()) e.push(`${table}.${col}=${src}`);
  return crypto.createHash('sha256').update(e.join('\n')).digest('hex');
}

type ManifestMode = { kind: 'real' } | { kind: 'value'; value: unknown } | { kind: 'absent' };

function instance(opts: { manifest?: ManifestMode; schemaOk?: boolean } = {}) {
  const manifest = opts.manifest ?? { kind: 'real' };
  jest.resetModules();
  if (manifest.kind === 'real') jest.dontMock(MANIFEST);
  else if (manifest.kind === 'value') jest.doMock(MANIFEST, () => manifest.value);
  else jest.doMock(MANIFEST, () => { const e: any = new Error('Cannot find module'); e.code = 'MODULE_NOT_FOUND'; throw e; });
  jest.doMock(RESULT, () => { const e: any = new Error('Cannot find module'); e.code = 'MODULE_NOT_FOUND'; throw e; }, { virtual: true });
  jest.doMock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
  const schemaOk = opts.schemaOk ?? true;
  jest.doMock('../../security/startup/schemaHealthCheck', () => ({
    __esModule: true,
    getSchemaHealth: async () => ({
      ok: schemaOk,
      missing: schemaOk ? [] : [{ table: 'users', column: 'status', migration: 'm', consumer: 'c' }],
      checkedAt: CHECKED_AT,
    }),
    resetSchemaHealthCache: () => {},
    REQUIRED_LIFECYCLE_COLUMNS: [],
  }));
  let m: any;
  jest.isolateModules(() => {
    m = {
      fp: require('../../security/startup/bootFingerprint'),
      boot: require('../../security/startup/authSubsystemBoot'),
      version: require('../../../pages/api/health/version').default,
      readiness: require('../../../pages/api/health/readiness').default,
    };
  });
  return m;
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
async function call(route: any) { const { res, out } = resDouble(); await route(getReq(), res); return out; }

afterAll(() => { jest.dontMock(MANIFEST); });

describe('the committed manifest is the one source', () => {
  it('sanity: the committed manifest is self-consistent (rows hash == manifest_hash)', () => {
    expect(COMMITTED_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(rowsHash(COMMITTED.columns)).toBe(COMMITTED_HASH);
  });

  it('deterministic across repeated init (three fresh instances)', () => {
    const hashes = [0, 1, 2].map(() => instance().fp.emitBootFingerprint().schemaManifestHash);
    expect(hashes).toEqual([COMMITTED_HASH, COMMITTED_HASH, COMMITTED_HASH]);
    expect(instance().fp.emitBootFingerprint().schemaManifestStatus).toBe('ok');
  });

  it('a different (self-consistent) manifest gives a different hash', () => {
    const columns = [...COMMITTED.columns, { table: 'users', column: 'zz_round12_probe', source_migration: 'x.sql', lifecycle_critical: false }];
    const other = { ...COMMITTED, columns, manifest_hash: rowsHash(columns) };
    const h = instance({ manifest: { kind: 'value', value: other } }).fp.emitBootFingerprint().schemaManifestHash;
    expect(h).toBe(other.manifest_hash);
    expect(h).not.toBe(COMMITTED_HASH);
  });
});

describe('route order cannot change the hash (independent instances)', () => {
  it('THE BUG: readiness FIRST, then version -> the committed hash, never the probe timestamp', async () => {
    const m = instance();
    const r = await call(m.readiness);
    const v = await call(m.version);
    expect(r.body.fingerprint.schemaManifestHash).toBe(COMMITTED_HASH);
    expect(v.body.schema_manifest_hash).toBe(COMMITTED_HASH);
    expect(v.body.schema_manifest_hash).not.toMatch(ISO);
    expect(v.body.schema_manifest_hash).not.toBe(CHECKED_AT);
  });

  it('version FIRST, then readiness -> the same committed hash', async () => {
    const m = instance();
    const v = await call(m.version);
    const r = await call(m.readiness);
    expect(v.body.schema_manifest_hash).toBe(COMMITTED_HASH);
    expect(r.body.fingerprint.schemaManifestHash).toBe(COMMITTED_HASH);
  });

  it('both orders agree with each other, fingerprint included', async () => {
    const a = instance(); await call(a.readiness); const va = await call(a.version);
    const b = instance(); const vb = await call(b.version); await call(b.readiness);
    expect(va.body.schema_manifest_hash).toBe(vb.body.schema_manifest_hash);
    expect(va.body.fingerprint).toBe(vb.body.fingerprint);
  });
});

describe('concurrent init', () => {
  it('concurrent readiness boots + version calls queued behind them all report the committed hash', async () => {
    const m = instance();
    const deferredVersion = () => new Promise<any>((resolve) => setImmediate(() => resolve(call(m.version))));
    const outs = await Promise.all([call(m.readiness), m.boot.bootAuthSubsystem(), call(m.readiness), deferredVersion(), deferredVersion()]);
    const hashes = [
      outs[0].body.fingerprint.schemaManifestHash,
      outs[1].fingerprint.schemaManifestHash,
      outs[2].body.fingerprint.schemaManifestHash,
      outs[3].body.schema_manifest_hash,
      outs[4].body.schema_manifest_hash,
    ];
    expect(new Set(hashes)).toEqual(new Set([COMMITTED_HASH]));
  });
});

describe('missing / invalid manifest are reported as such', () => {
  it('MISSING manifest -> schema_manifest_hash null + status missing', async () => {
    const m = instance({ manifest: { kind: 'absent' } });
    const v = await call(m.version);
    expect(v.body.schema_manifest_hash).toBeNull();
    expect(v.body.schema_manifest_status).toBe('missing');
  });

  it('MISSING manifest, readiness first -> still null, never the timestamp', async () => {
    const m = instance({ manifest: { kind: 'absent' } });
    const r = await call(m.readiness);
    expect(r.body.fingerprint.schemaManifestHash).toBeNull();
  });

  it.each([
    ['a timestamp as manifest_hash', { ...COMMITTED, manifest_hash: CHECKED_AT }],
    ['a hash that does not match the rows', { ...COMMITTED, manifest_hash: 'f'.repeat(64) }],
    ['an unsupported schema_version', { ...COMMITTED, schema_version: 2 }],
    ['no columns', { ...COMMITTED, columns: [] }],
    ['not an object', ['344021bc']],
  ])('INVALID manifest (%s) -> null + status invalid', async (_label, value) => {
    const m = instance({ manifest: { kind: 'value', value } });
    const v = await call(m.version);
    expect(v.body.schema_manifest_hash).toBeNull();
    expect(v.body.schema_manifest_status).toBe('invalid');
  });
});

describe('version (build metadata) vs readiness (runtime DB probe) stay distinct', () => {
  it('a DEGRADED probe makes readiness 503/schemaHealthy=false while the manifest hash is still reported', async () => {
    const m = instance({ schemaOk: false });
    const r = await call(m.readiness);
    const v = await call(m.version);
    expect(r.status).toBe(503);
    expect(r.body.schemaHealthy).toBe(false);
    expect(r.body.fingerprint.schemaManifestHash).toBe(COMMITTED_HASH);
    expect(v.status).toBe(200);
    expect(v.body.schema_manifest_hash).toBe(COMMITTED_HASH);
  });

  it('a MISSING manifest does not make a healthy probe unhealthy', async () => {
    const m = instance({ manifest: { kind: 'absent' }, schemaOk: true });
    const r = await call(m.readiness);
    expect(r.status).toBe(200);
    expect(r.body.schemaHealthy).toBe(true);
    expect(r.body.fingerprint.schemaManifestHash).toBeNull();
    const v = await call(m.version);
    expect(v.body.schema_manifest_status).toBe('missing');
  });

  it('version never reports readiness fields', async () => {
    const v = await call(instance().version);
    expect(v.body).not.toHaveProperty('schemaHealthy');
    expect(v.body).not.toHaveProperty('ready');
    expect(v.body).toHaveProperty('schema_manifest_status', 'ok');
  });
});
