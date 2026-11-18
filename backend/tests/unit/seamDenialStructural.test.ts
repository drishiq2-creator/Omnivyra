/**
 * Structural pin (e9 + 05, 2026-11-14): every pages/api catch of TenantSeamError answers through seamDenial
 * (backend/db/seamDenial.ts) - no local copies - so a RETRYABLE seam error (a failed parent read) is a 503 +
 * Retry-After everywhere, never a permanent 404/403. And seamDenial itself: retryable -> 503 + Retry-After with a
 * body that carries neither the id nor the error; otherwise the route's own denial.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { seamDenial, SEAM_RETRY_BODY } from '../../db/seamDenial';
import { TenantSeamError } from '../../db/tenantTable';

const ROOT = path.resolve(__dirname, '../../..');
/** Reviewed exemptions: a catch that sends NO response (best-effort background work). */
const EXEMPT: Record<string, string> = {
  'pages/api/campaigns/metrics.ts': 'updateCampaignCompletion is best-effort background bookkeeping: it logs the seam code and returns, no response',
};

/** Returns the offending `file:line` list for a source (pure, so the positive control can feed fixtures). */
export function rawSeamCatches(rel: string, src: string): string[] {
  if (EXEMPT[rel]) return [];
  const lines = src.split('\n');
  const usesDenial = /instanceof TenantSeamError\) return seamDeni(al|ed)\(/.test(src);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (!/instanceof TenantSeamError/.test(l)) return;
    if (/seamDeni(al|ed)\(/.test(l)) return;
    if (/instanceof TenantSeamError\) return \w+;\s*$/.test(l) && usesDenial) return; // helper hands the error to a seamDenial check
    if (/\{\s*$/.test(l) && /seamDeni(al|ed)\(/.test(lines.slice(i + 1, i + 4).join('\n'))) return;
    out.push(`${rel}:${i + 1}`);
  });
  return out;
}

describe('every pages/api TenantSeamError catch goes through seamDenial', () => {
  const files = execFileSync('git', ['grep', '-l', 'instanceof TenantSeamError', '--', 'pages/api'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  it('the scan sees the converted routes (positive control on the corpus)', () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
  });
  it('no raw catch remains', () => {
    const raw = files.flatMap((rel) => rawSeamCatches(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(raw).toEqual([]);
  });
  it('POSITIVE CONTROL: the scan flags a raw 404, a raw 403 block and a null-returning helper with a raw denial', () => {
    expect(rawSeamCatches('x.ts', "  if (err instanceof TenantSeamError) return res.status(404).json({ error: 'Campaign not found' });")).toEqual(['x.ts:1']);
    expect(rawSeamCatches('x.ts', 'if (e instanceof TenantSeamError) {\n  return res.status(403).json({});\n}')).toEqual(['x.ts:1']);
    expect(rawSeamCatches('x.ts', '  if (err instanceof TenantSeamError) return null;\n  if (!h) return res.status(403).json({});')).toEqual(['x.ts:1']);
  });
});

describe('seamDenial behaviour', () => {
  const fakeRes = () => {
    const r: any = { headers: {} as Record<string, string>, statusCode: 0, body: undefined };
    r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
    r.status = (s: number) => { r.statusCode = s; return r; };
    r.json = (b: unknown) => { r.body = b; return r; };
    return r;
  };
  it('a retryable (unreadable parent) error -> 503 + Retry-After, plain body without id or error text', () => {
    const err = new TenantSeamError('TENANT_PARENT_UNREADABLE', 'daily_content_plans: parent campaigns unreadable (57014) camp-secret-id');
    expect(err.retryable).toBe(true);
    const res = fakeRes();
    seamDenial(res, err, 404, { error: 'Campaign not found' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('5');
    expect(res.body).toEqual(SEAM_RETRY_BODY);
    expect(JSON.stringify(res.body)).not.toMatch(/camp-secret-id|57014|unreadable/);
  });
  it.each(['TENANT_MISMATCH', 'TENANT_CONTEXT_MISSING', 'TENANT_TABLE_UNKNOWN', 'TENANT_PAYLOAD_INVALID', 'TENANT_PARENT_FANOUT'] as const)(
    '%s -> not retryable -> the route\'s own denial', (code) => {
      const err = new TenantSeamError(code, 'x');
      expect(err.retryable).toBe(false);
      const res = fakeRes();
      seamDenial(res, err, 404, { error: 'Campaign not found' });
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Campaign not found' });
      expect(res.headers['Retry-After']).toBeUndefined();
    });
});

/*
 * FANOUT (coordinator ruling, 2026-11-18): TENANT_PARENT_FANOUT keeps the route's uniform deny EXACTLY, and the
 * server additionally emits an ERROR log `tenant_parent_fanout` {table, parentTable, key, limit} plus the counter
 * tenant_parent_fanout_total{table} (HARDEN-001 registry -> Prometheus). No key VALUE is ever echoed.
 */
describe('seamDenial: TENANT_PARENT_FANOUT is the uniform deny + an alertable server signal', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { logger } = require('../../services/logger');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registry } = require('../../observability/registry');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { observabilityConfig } = require('../../observability/config');
  const { TENANT_PARENT_FANOUT_EVENT, TENANT_PARENT_FANOUT_COUNTER } = require('../../db/seamDenial');

  const fakeRes = () => {
    const r: any = { headers: {} as Record<string, string>, statusCode: 0, body: undefined };
    r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
    r.status = (s: number) => { r.statusCode = s; return r; };
    r.json = (b: unknown) => { r.body = b; return r; };
    return r;
  };
  const answer = (err: TenantSeamError) => {
    const res = fakeRes();
    seamDenial(res, err, 404, { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
    return { status: res.statusCode, body: res.body, headers: res.headers };
  };
  const counter = (table: string): number =>
    registry.counterEntries()
      .filter((e: any) => e.name === TENANT_PARENT_FANOUT_COUNTER && e.labels?.table === table)
      .reduce((n: number, e: any) => n + e.value, 0);
  const SECRET = 'cc-secret-key-value-7f3a';
  let errSpy: jest.SpyInstance;
  beforeEach(() => { errSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined); });
  afterEach(() => errSpy.mockRestore());

  it('observability is enabled in this run (control: otherwise the counter assertions would be vacuous)', () => {
    expect(observabilityConfig.enabled).toBe(true);
  });

  it.each([
    // verifyParent fanout(), direct non-id key
    ['content_asset_attachment: parent key matches more than 50 content_core_asset rows (availability limit, not a tenant mismatch)',
      { table: 'content_asset_attachment', parentTable: 'content_core_asset', key: 'content_core_id', limit: 50 }],
    // verifyParent fanout(), hop 1 of a multi-hop chain (content_asset_versions -> content_assets by asset_id)
    ['content_asset_versions: parent key matches more than 50 content_assets rows (availability limit, not a tenant mismatch)',
      { table: 'content_asset_versions', parentTable: 'content_assets', key: 'asset_id', limit: 50 }],
    // tenantChildTableOf batch limit
    ['scheduled_posts: 201 parents in one call (limit 200; split it)',
      { table: 'scheduled_posts', parentTable: 'campaigns', key: 'id', limit: 200 }],
  ])('(a) FANOUT %# -> identical status + body to a TENANT_MISMATCH deny; log + counter once, right labels, no value', (message, fields) => {
    const before = counter(fields.table);
    const fan = answer(new TenantSeamError('TENANT_PARENT_FANOUT', `${message} ${SECRET}`));
    const mismatch = answer(new TenantSeamError('TENANT_MISMATCH', 'x: parent campaigns is not in this tenant'));
    expect(fan).toEqual(mismatch);
    expect(fan.status).toBe(404);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(TENANT_PARENT_FANOUT_EVENT, fields);
    expect(TENANT_PARENT_FANOUT_EVENT).toBe('tenant_parent_fanout');
    expect(counter(fields.table) - before).toBe(1);
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(fan)).not.toContain(SECRET);
  });

  it('(b) TENANT_MISMATCH -> no fanout log, no counter', () => {
    const before = counter('campaign_week_plan');
    const totalBefore = registry.counterEntries().filter((e: any) => e.name === TENANT_PARENT_FANOUT_COUNTER).reduce((n: number, e: any) => n + e.value, 0);
    answer(new TenantSeamError('TENANT_MISMATCH', 'campaign_week_plan: parent campaigns is not in this tenant'));
    expect(errSpy).not.toHaveBeenCalled();
    expect(counter('campaign_week_plan')).toBe(before);
    const totalAfter = registry.counterEntries().filter((e: any) => e.name === TENANT_PARENT_FANOUT_COUNTER).reduce((n: number, e: any) => n + e.value, 0);
    expect(totalAfter).toBe(totalBefore);
  });

  it('reportTenantFanout (for catches that stay non-blocking): fires once for FANOUT only, never throws', () => {
    const { reportTenantFanout } = require('../../db/seamDenial');
    const before = counter('campaign_week_plan');
    expect(reportTenantFanout(new TenantSeamError('TENANT_MISMATCH', 'campaign_week_plan: parent campaigns is not in this tenant'))).toBe(false);
    expect(reportTenantFanout(new Error('plain'))).toBe(false);
    expect(reportTenantFanout(undefined)).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
    expect(reportTenantFanout(new TenantSeamError('TENANT_PARENT_FANOUT', 'campaign_week_plan: parent key matches more than 50 campaigns rows (x)'))).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(TENANT_PARENT_FANOUT_EVENT, { table: 'campaign_week_plan', parentTable: 'campaigns', key: 'id', limit: 50 });
    expect(counter('campaign_week_plan') - before).toBe(1);
  });

  it('(c) retryable (unreadable parent) -> 503 + Retry-After unchanged, no fanout signal', () => {
    const got = answer(new TenantSeamError('TENANT_PARENT_UNREADABLE', 'campaign_week_plan: parent campaigns unreadable (57014)'));
    expect(got).toEqual({ status: 503, body: SEAM_RETRY_BODY, headers: { 'Retry-After': '5' } });
    expect(errSpy).not.toHaveBeenCalled();
  });
});
