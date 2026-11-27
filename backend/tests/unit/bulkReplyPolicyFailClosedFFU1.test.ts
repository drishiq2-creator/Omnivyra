/**
 * F-FU1 (owner 2026-11-27) — the shared bulk-reply policy fails CLOSED.
 *
 * "The shared bulk-reply policy must fail closed when the database read fails."
 * A genuine read error on engagement_system_controls must never be read as
 * "bulk replies enabled". Both bulk routes (thread/bulk-ai-reply and
 * thread/bulk-pattern-reply) refuse with 503 BULK_REPLY_CONTROLS_UNREADABLE
 * before any read, generation, queue or send. A genuinely ABSENT row keeps the
 * product default: enabled.
 *
 * The REAL readBulkReplyEnabled runs here; only the DB boundary
 * (writeOwner.ownedDbTable) is mocked, so the route tests exercise the strict
 * reader end to end. getControls is unchanged and still returns enabled on a
 * read error — pinned at the bottom.
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

// ── The policy table (DB boundary under the REAL reader) ─────────────────────
type PolicyResult = { data: unknown; error: unknown };
const policyByOrg = new Map<string, PolicyResult>();
let policyThrows: Error | null = null;
const policyReads: { table: string; columns: string; org: unknown }[] = [];
const ownedWriteMock = jest.fn();
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const read = { table, columns: '', org: undefined as unknown };
    const chain: any = {
      select: (cols: string) => { read.columns = cols; return chain; },
      eq: (col: string, val: unknown) => { if (col === 'organization_id') read.org = val; return chain; },
      maybeSingle: async () => {
        policyReads.push(read);
        if (policyThrows) throw policyThrows;
        return policyByOrg.get(String(read.org)) ?? { data: null, error: null };
      },
      insert: (...a: unknown[]) => { ownedWriteMock('insert', table, ...a); return chain; },
      update: (...a: unknown[]) => { ownedWriteMock('update', table, ...a); return chain; },
      upsert: (...a: unknown[]) => { ownedWriteMock('upsert', table, ...a); return chain; },
      delete: (...a: unknown[]) => { ownedWriteMock('delete', table, ...a); return chain; },
    };
    return chain;
  },
}));

// ── Side-effect boundaries ───────────────────────────────────────────────────
const generateResponseMock = jest.fn(async (_i: unknown) => ({ text: 'generated reply' }));
jest.mock('../../services/responseGenerationService', () => ({
  generateResponse: (i: unknown) => generateResponseMock(i),
}));
const generateReplySuggestionsMock = jest.fn(async (_m: string, _o: string) => ({
  suggested_replies: [{ text: 'Thanks!' }],
}));
jest.mock('../../services/engagementAiAssistantService', () => ({
  generateReplySuggestions: (m: string, o: string) => generateReplySuggestionsMock(m, o),
}));
const getThreadActionabilityMock = jest.fn(
  async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, true] as [string, boolean])),
);
jest.mock('../../services/engagementThreadService', () => ({
  getThreadActionability: (org: string, ids: string[]) => getThreadActionabilityMock(org, ids),
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

// ── Supabase (pattern route reads): record every table touched and every write
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

import bulkAiHandler from '../../../pages/api/engagement/thread/bulk-ai-reply';
import bulkPatternHandler from '../../../pages/api/engagement/thread/bulk-pattern-reply';
import {
  readBulkReplyEnabled,
  getControls,
  EngagementControlsUnreadableError,
} from '../../services/engagementGovernanceService';

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
const row = (v: unknown): PolicyResult => ({ data: { bulk_reply_enabled: v }, error: null });
const readError: PolicyResult = { data: null, error: { message: 'permission denied for table', code: '42501' } };

const ROUTES = [
  {
    name: 'bulk-ai-reply',
    handler: bulkAiHandler as unknown as (req: unknown, res: unknown) => Promise<unknown>,
    body: { thread_ids: ['t1', 't2'] },
    event: 'bulk_ai_reply_refused',
    generation: () => generateReplySuggestionsMock,
    // Every downstream read this route makes after the policy check.
    downstreamReads: () => getThreadActionabilityMock.mock.calls.length + fromMock.mock.calls.length,
  },
  {
    name: 'bulk-pattern-reply',
    handler: bulkPatternHandler as unknown as (req: unknown, res: unknown) => Promise<unknown>,
    body: { thread_ids: ['t1', 't2'], pattern_id: 'pat_1' },
    event: 'bulk_pattern_reply_refused',
    generation: () => generateResponseMock,
    downstreamReads: () => getThreadActionabilityMock.mock.calls.length + fromMock.mock.calls.length,
  },
];

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  policyByOrg.clear();
  policyReads.length = 0;
  policyThrows = null;
  defaultCompanyId = ORG_B;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

function expectNothingDownstream(r: (typeof ROUTES)[number]) {
  expect(r.generation()).not.toHaveBeenCalled();
  expect(r.downstreamReads()).toBe(0);
  expect(bulkReplyThreadsMock).not.toHaveBeenCalled();
  expect(writeMock).not.toHaveBeenCalled();
  expect(ownedWriteMock).not.toHaveBeenCalled();
}

describe.each(ROUTES)('F-FU1 $name — bulk-reply policy fails closed', (r) => {
  it('policy row enabled (true) -> proceeds to generation and bulkReplyThreads', async () => {
    policyByOrg.set(ORG_A, row(true));
    const res = mockRes();
    await r.handler(post({ ...r.body, organization_id: ORG_A }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, sent: 2 });
    expect(r.generation()).toHaveBeenCalledTimes(2);
    expect(bulkReplyThreadsMock).toHaveBeenCalledTimes(1);
    expect(bulkReplyThreadsMock.mock.calls[0][0]).toBe(ORG_A);
    // The strict reader read exactly the one column, for exactly this tenant.
    expect(policyReads).toEqual([{ table: 'engagement_system_controls', columns: 'bulk_reply_enabled', org: ORG_A }]);
  });

  it('policy row disabled (false) -> 403 BULK_REPLY_DISABLED; nothing read, generated, queued or written', async () => {
    policyByOrg.set(ORG_A, row(false));
    const res = mockRes();
    await r.handler(post({ ...r.body, organization_id: ORG_A }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: 'Bulk reply is disabled for this organization',
      code: 'BULK_REPLY_DISABLED',
    });
    expect(policyReads).toHaveLength(1);
    expectNothingDownstream(r);
  });

  it('policy row ABSENT -> product default (enabled) -> proceeds', async () => {
    // no policyByOrg entry: { data: null, error: null }
    const res = mockRes();
    await r.handler(post({ ...r.body, organization_id: ORG_A }), res);

    expect(policyReads).toHaveLength(1);
    expect(res.statusCode).toBe(200);
    expect(r.generation()).toHaveBeenCalledTimes(2);
    expect(bulkReplyThreadsMock).toHaveBeenCalledTimes(1);
  });

  it('DB READ ERROR -> 503 BULK_REPLY_CONTROLS_UNREADABLE; nothing read, generated, queued, sent or written', async () => {
    policyByOrg.set(ORG_A, readError);
    const res = mockRes();
    await r.handler(post({ ...r.body, organization_id: ORG_A }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'Bulk reply policy could not be read',
      code: 'BULK_REPLY_CONTROLS_UNREADABLE',
    });
    expect(policyReads).toHaveLength(1);
    expectNothingDownstream(r);

    // One structured log line: event, code, organization_id only.
    const lines = errorSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('{'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      event: r.event,
      code: 'BULK_REPLY_CONTROLS_UNREADABLE',
      organization_id: ORG_A,
    });
    expect(lines[0]).not.toContain('permission denied');
  });

  it('a NON-policy failure in the read (thrown) still flows to the existing catch: 500, nothing sent', async () => {
    policyThrows = new Error('socket hang up');
    const res = mockRes();
    await r.handler(post({ ...r.body, organization_id: ORG_A }), res);

    expect(res.statusCode).toBe(500);
    expectNothingDownstream(r);
  });

  it('tenant isolation: A disabled is refused, B enabled proceeds; reads use the access-validated org id', async () => {
    policyByOrg.set(ORG_A, row(false));
    policyByOrg.set(ORG_B, row(true));
    defaultCompanyId = ORG_B; // user's default is the ENABLED tenant

    const resA = mockRes();
    await r.handler(post({ ...r.body, organization_id: ORG_A }), resA);
    expect(resA.statusCode).toBe(403);
    expect(enforceCompanyAccessMock).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: ORG_A }));
    expect(policyReads.map((p) => p.org)).toEqual([ORG_A]);
    expect(bulkReplyThreadsMock).not.toHaveBeenCalled();

    const resB = mockRes();
    await r.handler(post({ ...r.body, organization_id: ORG_B }), resB);
    expect(resB.statusCode).toBe(200);
    expect(enforceCompanyAccessMock).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: ORG_B }));
    expect(policyReads.map((p) => p.org)).toEqual([ORG_A, ORG_B]);
    expect(bulkReplyThreadsMock).toHaveBeenCalledTimes(1);
    expect(bulkReplyThreadsMock.mock.calls[0][0]).toBe(ORG_B);
  });

  it('auth ordering: access denial or role denial never reaches the policy read', async () => {
    enforceCompanyAccessMock.mockImplementationOnce(async () => null);
    await r.handler(post({ ...r.body, organization_id: ORG_A }), mockRes());
    expect(enforceCompanyAccessMock).toHaveBeenCalledTimes(1);
    expect(policyReads).toHaveLength(0);

    enforceRoleMock.mockImplementationOnce(async () => null);
    await r.handler(post({ ...r.body, organization_id: ORG_A }), mockRes());
    expect(enforceRoleMock).toHaveBeenCalledTimes(1);
    expect(policyReads).toHaveLength(0);
    expect(bulkReplyThreadsMock).not.toHaveBeenCalled();

    // Positive control: with access + role granted the read IS made.
    await r.handler(post({ ...r.body, organization_id: ORG_A }), mockRes());
    expect(policyReads).toHaveLength(1);
  });
});

describe('F-FU1 readBulkReplyEnabled (strict reader, real implementation)', () => {
  it('row true -> true', async () => {
    policyByOrg.set(ORG_A, row(true));
    await expect(readBulkReplyEnabled(ORG_A)).resolves.toBe(true);
    expect(policyReads).toEqual([{ table: 'engagement_system_controls', columns: 'bulk_reply_enabled', org: ORG_A }]);
  });

  it('row false -> false', async () => {
    policyByOrg.set(ORG_A, row(false));
    await expect(readBulkReplyEnabled(ORG_A)).resolves.toBe(false);
  });

  it('row with null value -> true (same `?? true` semantics as getControls)', async () => {
    policyByOrg.set(ORG_A, row(null));
    await expect(readBulkReplyEnabled(ORG_A)).resolves.toBe(true);
    const viaGetControls = await getControls(ORG_A);
    expect(viaGetControls.bulk_reply_enabled).toBe(true);
  });

  it('no row -> true (product default)', async () => {
    await expect(readBulkReplyEnabled(ORG_A)).resolves.toBe(true);
    expect(policyReads).toHaveLength(1);
  });

  it('read error -> throws EngagementControlsUnreadableError (org id + message, never the raw error)', async () => {
    policyByOrg.set(ORG_A, readError);
    let caught: unknown;
    try {
      await readBulkReplyEnabled(ORG_A);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngagementControlsUnreadableError);
    const err = caught as EngagementControlsUnreadableError;
    expect(err.name).toBe('EngagementControlsUnreadableError');
    expect(err.organizationId).toBe(ORG_A);
    expect(err.causeMessage).toBe('permission denied for table');
    // The raw DB error object is not attached anywhere on the error.
    expect(Object.values(err)).not.toContain(readError.error);
    expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it('empty organization id -> throws EngagementControlsUnreadableError without a DB read', async () => {
    await expect(readBulkReplyEnabled('')).rejects.toBeInstanceOf(EngagementControlsUnreadableError);
    expect(policyReads).toHaveLength(0);
  });
});

describe('F-FU1 — getControls is UNCHANGED (other consumers keep today\'s behaviour)', () => {
  it('getControls still returns bulk_reply_enabled=true on a read error (documented, not used by bulk routes)', async () => {
    policyByOrg.set(ORG_A, readError);
    const controls = await getControls(ORG_A);
    expect(controls.bulk_reply_enabled).toBe(true);
    // Control: the same read error makes the strict reader refuse.
    await expect(readBulkReplyEnabled(ORG_A)).rejects.toBeInstanceOf(EngagementControlsUnreadableError);
  });

  it('neither bulk route still calls getControls', () => {
    const fs = require('fs') as typeof import('fs');
    for (const f of [
      'pages/api/engagement/thread/bulk-ai-reply.ts',
      'pages/api/engagement/thread/bulk-pattern-reply.ts',
    ]) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).not.toMatch(/\bgetControls\b/);
      expect(src).toMatch(/readBulkReplyEnabled\(organizationId\)/);
    }
  });
});
