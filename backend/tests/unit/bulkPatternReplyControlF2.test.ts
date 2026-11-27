/**
 * FIX-2 — bulk-pattern-reply must honour the tenant's bulk-reply switch.
 *
 * Its sibling thread/bulk-ai-reply already refuses when
 * engagement_system_controls.bulk_reply_enabled is false; bulk-pattern-reply
 * never asked, so a tenant that disabled bulk reply could still mass-send
 * pattern replies. The switch is read through the shared contract
 * (engagementGovernanceService.getControls), for the access-validated tenant,
 * after access + role and before any pattern read, generation or send.
 *
 * UPDATED (F-FU1, owner 2026-11-27): the routes now read the switch through the
 * strict, fail-closed engagementGovernanceService.readBulkReplyEnabled; the
 * fail-closed behaviour itself is covered in bulkReplyPolicyFailClosedFFU1.test.ts.
 */

// ── Route scaffolding ────────────────────────────────────────────────────────
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

const USER = 'user_1';
const ORG_A = 'org_A';
const ORG_B = 'org_B';

let defaultCompanyId = ORG_B;
const enforceCompanyAccessMock = jest.fn(async (_a: { companyId: string }) => ({ userId: USER }) as unknown);
const enforceRoleMock = jest.fn(async (_a: { companyId: string }) => ({ userId: USER }) as unknown);
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => ({ userId: USER, defaultCompanyId }),
  enforceCompanyAccess: (a: { companyId: string }) => enforceCompanyAccessMock(a),
}));
jest.mock('../../services/rbacService', () => ({
  enforceRole: (a: { companyId: string }) => enforceRoleMock(a),
}));
jest.mock('../../services/rbac/communityAiCapabilities', () => ({
  COMMUNITY_AI_CAPABILITIES: { EXECUTE_ACTIONS: ['SUPER_ADMIN'], VIEW_ACTIONS: ['SUPER_ADMIN'] },
}));
jest.mock('../../services/taggedResponseInterpreter', () => ({
  SUPPORTED_TAGS: ['greeting', 'acknowledgement', 'answer'],
}));

// ── The tenant switch (shared contract) ──────────────────────────────────────
// UPDATED (F-FU1, owner 2026-11-27): the route reads the switch via the strict
// readBulkReplyEnabled (fail closed) instead of getControls.
const disabledOrgs = new Set<string>();
const readBulkReplyEnabledMock = jest.fn(async (org: string) => !disabledOrgs.has(org));
jest.mock('../../services/engagementGovernanceService', () => ({
  readBulkReplyEnabled: (org: string) => readBulkReplyEnabledMock(org),
  EngagementControlsUnreadableError: class EngagementControlsUnreadableError extends Error {},
}));

// ── Side-effect boundaries ───────────────────────────────────────────────────
const generateResponseMock = jest.fn(async (_i: unknown) => ({ text: 'generated reply' }));
jest.mock('../../services/responseGenerationService', () => ({
  generateResponse: (i: unknown) => generateResponseMock(i),
}));

type GetReplyText = (t: string, m: string, p: string) => Promise<string | null>;
const bulkReplyThreadsMock = jest.fn(
  async (_org: string, ids: string[], getReplyText: GetReplyText, _u?: string | null) => {
    // Mirror the real service: it calls getReplyText per thread before sending.
    for (const id of ids) await getReplyText(id, `msg_${id}`, 'linkedin');
    return { sent: ids.length, skipped: 0, errors: [] as string[], outcomes: {} };
  },
);
jest.mock('../../services/bulkEngagementService', () => ({
  bulkReplyThreads: (...a: [string, string[], GetReplyText, string?]) => bulkReplyThreadsMock(...a),
}));

// ── Supabase: record every table touched and every write ─────────────────────
const fromMock = jest.fn();
const writeMock = jest.fn();
function builder(table: string) {
  const api: any = {
    select: () => api,
    eq: () => api,
    in: () => api,
    order: () => api,
    limit: () => api,
    maybeSingle: async () => {
      if (table === 'response_patterns') {
        return { data: { id: 'pat_1', pattern_structure: { blocks: [{ type: 'answer', label: 'Help' }] } }, error: null };
      }
      if (table === 'engagement_messages') {
        return { data: { id: 'm', content: 'hi', thread_id: 't' }, error: null };
      }
      return { data: null, error: null };
    },
    insert: (...a: unknown[]) => { writeMock('insert', table, ...a); return api; },
    update: (...a: unknown[]) => { writeMock('update', table, ...a); return api; },
    upsert: (...a: unknown[]) => { writeMock('upsert', table, ...a); return api; },
    delete: (...a: unknown[]) => { writeMock('delete', table, ...a); return api; },
  };
  return api;
}
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: (t: string) => { fromMock(t); return builder(t); } },
}));

import handler from '../../../pages/api/engagement/thread/bulk-pattern-reply';

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = () => res;
  return res;
}
function post(body: Record<string, unknown>) {
  return { method: 'POST', body, headers: {}, query: {} } as any;
}
const BODY = { thread_ids: ['t1', 't2'], pattern_id: 'pat_1' };

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  disabledOrgs.clear();
  defaultCompanyId = ORG_B;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('FIX-2 bulk-pattern-reply — tenant bulk-reply switch', () => {
  it('enabled: proceeds to pattern read, generation and bulkReplyThreads as before', async () => {
    const res = mockRes();
    await handler(post({ ...BODY, organization_id: ORG_A }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, sent: 2 });
    expect(readBulkReplyEnabledMock).toHaveBeenCalledWith(ORG_A);
    expect(fromMock).toHaveBeenCalledWith('response_patterns');
    expect(generateResponseMock).toHaveBeenCalledTimes(2);
    expect(bulkReplyThreadsMock).toHaveBeenCalledTimes(1);
    expect(bulkReplyThreadsMock.mock.calls[0][0]).toBe(ORG_A);
  });

  it('disabled: 403 BULK_REPLY_DISABLED; no pattern read, generation, send or DB write', async () => {
    disabledOrgs.add(ORG_A);
    const res = mockRes();
    await handler(post({ ...BODY, organization_id: ORG_A }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: 'Bulk reply is disabled for this organization',
      code: 'BULK_REPLY_DISABLED',
    });
    expect(generateResponseMock).not.toHaveBeenCalled();
    expect(bulkReplyThreadsMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();

    // Structured log line carrying the org id only.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warnSpy.mock.calls[0][0]));
    expect(logged).toEqual({
      event: 'bulk_pattern_reply_refused',
      code: 'BULK_REPLY_DISABLED',
      organization_id: ORG_A,
    });
  });

  it('switch is read only AFTER access + role pass (denied access never reaches it)', async () => {
    enforceCompanyAccessMock.mockImplementationOnce(async () => null);
    await handler(post({ ...BODY, organization_id: ORG_A }), mockRes());
    expect(readBulkReplyEnabledMock).not.toHaveBeenCalled();

    enforceRoleMock.mockImplementationOnce(async () => null);
    await handler(post({ ...BODY, organization_id: ORG_A }), mockRes());
    expect(readBulkReplyEnabledMock).not.toHaveBeenCalled();
    expect(bulkReplyThreadsMock).not.toHaveBeenCalled();
  });

  it('tenant isolation: org A disabled is refused even though org B (user default) is enabled', async () => {
    disabledOrgs.add(ORG_A);
    defaultCompanyId = ORG_B;
    const res = mockRes();
    await handler(post({ ...BODY, organization_id: ORG_A }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('BULK_REPLY_DISABLED');
    // The switch was read for exactly the tenant access validated.
    expect(enforceCompanyAccessMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: ORG_A }));
    expect(readBulkReplyEnabledMock).toHaveBeenCalledTimes(1);
    expect(readBulkReplyEnabledMock).toHaveBeenCalledWith(ORG_A);
    expect(bulkReplyThreadsMock).not.toHaveBeenCalled();

    // ...and B, enabled, still proceeds — A's switch does not leak to B.
    const resB = mockRes();
    await handler(post({ ...BODY, organization_id: ORG_B }), resB);
    expect(resB.statusCode).toBe(200);
    expect(readBulkReplyEnabledMock).toHaveBeenLastCalledWith(ORG_B);
    expect(bulkReplyThreadsMock).toHaveBeenCalledTimes(1);
    expect(bulkReplyThreadsMock.mock.calls[0][0]).toBe(ORG_B);
  });

  it('controls lookup that THROWS: no generation, no send, non-2xx (fails closed)', async () => {
    readBulkReplyEnabledMock.mockImplementationOnce(async () => { throw new Error('controls unavailable'); });
    const res = mockRes();
    await handler(post({ ...BODY, organization_id: ORG_A }), res);

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(generateResponseMock).not.toHaveBeenCalled();
    expect(bulkReplyThreadsMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('FIX-2 — documented shared-helper behaviour (owner decision, NOT changed here)', () => {
  // getControls swallows a read error into DEFAULTS (bulk_reply_enabled: true),
  // the same value it returns for "no row".
  // UPDATED (F-FU1, owner 2026-11-27): getControls is still UNCHANGED (its other
  // consumers keep this behaviour), but the bulk routes no longer use it — they
  // use readBulkReplyEnabled, which fails CLOSED on a read error.
  function realGetControlsWith(result: { data: unknown; error: unknown }) {
    let getControls!: (org: string) => Promise<{ bulk_reply_enabled: boolean }>;
    jest.isolateModules(() => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => result,
      };
      jest.doMock('../../db/writeOwner', () => ({ ownedDbTable: () => chain }));
      jest.doMock('../../db/supabaseClient', () => ({ supabase: {} }));
      ({ getControls } = jest.requireActual('../../services/engagementGovernanceService'));
    });
    return getControls;
  }

  it('row with bulk_reply_enabled=false -> false (control: the helper does read the row)', async () => {
    const getControls = realGetControlsWith({ data: { bulk_reply_enabled: false }, error: null });
    expect((await getControls(ORG_A)).bulk_reply_enabled).toBe(false);
  });

  it('no row -> enabled (product default, shared with bulk-ai-reply)', async () => {
    const getControls = realGetControlsWith({ data: null, error: null });
    expect((await getControls(ORG_A)).bulk_reply_enabled).toBe(true);
  });

  // UPDATED (F-FU1, owner 2026-11-27): pin kept — getControls itself is unchanged;
  // the bulk routes are protected by readBulkReplyEnabled instead.
  it('READ ERROR -> enabled (getControls unchanged; bulk routes no longer use it)', async () => {
    const getControls = realGetControlsWith({ data: null, error: { message: 'permission denied' } });
    expect((await getControls(ORG_A)).bulk_reply_enabled).toBe(true);
  });
});

describe('FIX-2 — individual replies are not governed by the bulk switch', () => {
  const fs = require('fs') as typeof import('fs');
  const consultsBulkSwitch = (file: string) => {
    const src = fs.readFileSync(file, 'utf8');
    return /getControls|bulk_reply_enabled|engagementGovernanceService/.test(src);
  };

  it('control: the scanner detects the switch in bulk-pattern-reply.ts', () => {
    expect(consultsBulkSwitch('pages/api/engagement/thread/bulk-pattern-reply.ts')).toBe(true);
  });

  it('pages/api/engagement/reply.ts does not consult the bulk-reply switch', () => {
    expect(consultsBulkSwitch('pages/api/engagement/reply.ts')).toBe(false);
  });
});
