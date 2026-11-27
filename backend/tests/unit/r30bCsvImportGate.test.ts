/**
 * Round 30B (owner decision 6) — `/api/lead-ingestion/csv` is gated by the SAME per-company `prospect_import` gate as
 * the wizard's mapping routes, so a direct API call cannot import for a company the wizard is closed for.
 *
 * REAL: the route handler and `resolveProspectImportGate` (the subject), including its strict flag read and its
 * PI-LDB schema switch (process.env.PI_LDB_SCHEMA_READY). DOUBLED: membership (enforceCompanyAccess), the capability
 * check, the flag service's database read, the tenant lead-ingestion gate, the orchestrator and telemetry.
 * Every refusal has an accepted control.
 */
const enforceCompanyAccess = jest.fn();
const requireCapability = jest.fn();
const trackEvent = jest.fn();
const ingestLeadBatch = jest.fn();
const evaluateFeatureFlag = jest.fn();
let tenantIngestionAllowed = true;

jest.mock('../../services/userContextService', () => ({ enforceCompanyAccess: (...a: unknown[]) => enforceCompanyAccess(...a) }));
jest.mock('../../security/requireCapability', () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
jest.mock('../../services/featureFlagService', () => ({ evaluateFeatureFlag: (...a: unknown[]) => evaluateFeatureFlag(...a) }));
jest.mock('../../services/leadIngestion/orchestrator', () => ({
  ingestLeadBatch: (...a: unknown[]) => ingestLeadBatch(...a),
  isLeadIngestionEnabled: () => true,
  resolveLeadIngestionGate: async () => ({ allowed: tenantIngestionAllowed, reason: tenantIngestionAllowed ? 'tenant_flag:on' : 'tenant_flag:no_flag_row' }),
  MAX_BATCH_SIZE: 100,
}));
jest.mock('../../services/leadIngestion', () => ({ registerBuiltInLeadSources: () => undefined }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import handler from '../../../pages/api/lead-ingestion/csv';
import type { NextApiRequest, NextApiResponse } from 'next';

const ORG_A = '00000000-0000-4000-8000-0000000000aa';
const ORG_B = '00000000-0000-4000-8000-0000000000bb';
const OK = { source: 'csv', total: 1, succeeded: 1, failed: 0, projected: 1, notProjected: 0, outcomes: [] };

type Res = NextApiResponse & { _status: number; _json: Record<string, unknown> };
const call = async (company = ORG_A) => {
  const r: Partial<Res> = { _status: 0, _json: {} };
  r.status = ((c: number) => { (r as Res)._status = c; return r as Res; }) as Res['status'];
  r.json = ((b: Record<string, unknown>) => { (r as Res)._json = b; return r as Res; }) as Res['json'];
  r.setHeader = (() => r) as unknown as Res['setHeader'];
  const req = { method: 'POST', query: { company_id: company }, body: { records: [{ email: 'dana@example.com' }] }, url: '/api/lead-ingestion/csv' } as unknown as NextApiRequest;
  await (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, r as Res);
  return r as Res;
};

let savedSchema: string | undefined;
beforeEach(() => {
  jest.clearAllMocks();
  savedSchema = process.env.PI_LDB_SCHEMA_READY;
  process.env.PI_LDB_SCHEMA_READY = 'true';
  tenantIngestionAllowed = true;
  enforceCompanyAccess.mockResolvedValue({ userId: 'u-1' });
  requireCapability.mockResolvedValue({ ok: true, principal: { userId: 'u-1' } });
  ingestLeadBatch.mockResolvedValue(OK);
  evaluateFeatureFlag.mockResolvedValue({ enabled: true, reason: 'flag_enabled_full_rollout' });
});
afterEach(() => { if (savedSchema === undefined) delete process.env.PI_LDB_SCHEMA_READY; else process.env.PI_LDB_SCHEMA_READY = savedSchema; });

const expectImportClosed = (res: Res) => {
  expect(res._status).toBe(404);
  expect(res._json.code).toBe('PROSPECT_IMPORT_DISABLED');
  expect(ingestLeadBatch).not.toHaveBeenCalled();
  expect(trackEvent).not.toHaveBeenCalled();
};

describe('CSV route - the per-company prospect_import gate', () => {
  it('CONTROL: flag enabled -> 200, ingested for the VERIFIED company, flag read for that company and key', async () => {
    const res = await call();
    expect(res._status).toBe(200);
    expect(ingestLeadBatch).toHaveBeenCalledTimes(1);
    expect(ingestLeadBatch.mock.calls[0][0]).toMatchObject({ organizationId: ORG_A, source: 'csv' });
    expect(evaluateFeatureFlag).toHaveBeenCalledWith({ organizationId: ORG_A, flagKey: 'prospect_import', cohortKey: null });
  });

  it('flag disabled -> 404 PROSPECT_IMPORT_DISABLED, nothing ingested', async () => {
    evaluateFeatureFlag.mockResolvedValue({ enabled: false, reason: 'flag_disabled' });
    const res = await call();
    expectImportClosed(res);
    expect(res._json).toEqual({ error: 'Prospect import is not enabled.', code: 'PROSPECT_IMPORT_DISABLED', reason: 'tenant_flag:flag_disabled' });
  });

  it('flag missing (no row) -> 404', async () => {
    evaluateFeatureFlag.mockResolvedValue({ enabled: false, reason: 'no_flag_row' });
    expectImportClosed(await call());
  });

  it.each([
    ['string "true"', { enabled: 'true', reason: 'x' }],
    ['number 1', { enabled: 1, reason: 'x' }],
    ['enabled missing', { reason: 'x' }],
    ['null answer', null],
    ['undefined answer', undefined],
  ])('malformed flag answer (%s) -> 404, fails closed', async (_l, answer) => {
    evaluateFeatureFlag.mockResolvedValue(answer);
    expectImportClosed(await call());
  });

  it('flag unavailable (the read throws) -> 404, fails closed', async () => {
    evaluateFeatureFlag.mockRejectedValue(new Error('db down'));
    const res = await call();
    expectImportClosed(res);
    expect(String(res._json.reason)).toMatch(/^flag_evaluation_failed/);
  });

  it('PI-LDB schema switch not exactly "true" -> 404 before the flag is read', async () => {
    for (const v of [undefined, 'false', 'TRUE', ' true']) {
      jest.clearAllMocks();
      if (v === undefined) delete process.env.PI_LDB_SCHEMA_READY; else process.env.PI_LDB_SCHEMA_READY = v;
      const res = await call();
      expectImportClosed(res);
      expect(res._json.reason).toBe('schema_not_ready');
      expect(evaluateFeatureFlag).not.toHaveBeenCalled();
    }
  });

  it('the tenant lead-ingestion gate closed -> the EXISTING LEAD_INGESTION_DISABLED contract (code unchanged)', async () => {
    tenantIngestionAllowed = false;
    const res = await call();
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'Lead ingestion is not enabled.', code: 'LEAD_INGESTION_DISABLED', reason: 'tenant_flag:no_flag_row' });
    expect(ingestLeadBatch).not.toHaveBeenCalled();
    expect(evaluateFeatureFlag).not.toHaveBeenCalled();
  });

  it('tenant isolation: company A enabled does not open company B', async () => {
    evaluateFeatureFlag.mockImplementation(async ({ organizationId }: { organizationId: string }) =>
      (organizationId === ORG_A ? { enabled: true, reason: 'on' } : { enabled: false, reason: 'no_flag_row' }));
    expectImportClosed(await call(ORG_B));
    expect(evaluateFeatureFlag).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_B }));
    jest.clearAllMocks();
    ingestLeadBatch.mockResolvedValue(OK);
    expect((await call(ORG_A))._status).toBe(200);
  });

  it('unauthorised (not a member): refused by membership; the flag is never read, nothing ingested', async () => {
    enforceCompanyAccess.mockImplementation(async ({ res }: { res: Res }) => { res.status(403).json({ error: 'forbidden' }); return null; });
    const res = await call();
    expect(res._status).toBe(403);
    expect(evaluateFeatureFlag).not.toHaveBeenCalled();
    expect(ingestLeadBatch).not.toHaveBeenCalled();
  });

  it('missing capability: refused by requireCapability; the flag is never read', async () => {
    requireCapability.mockImplementation(async (_q: unknown, res: Res) => { res.status(403).json({ error: 'capability' }); return { ok: false }; });
    const res = await call();
    expect(res._status).toBe(403);
    expect(evaluateFeatureFlag).not.toHaveBeenCalled();
    expect(ingestLeadBatch).not.toHaveBeenCalled();
  });
});
