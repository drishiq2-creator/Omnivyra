/**
 * R26 F-1 — super-admin Community-AI platform policy save defaults.
 *
 * Defect (2bc52db7a): with no policy row, a save that named only one field
 * persisted `auto_rules_enabled: existing?.auto_rules_enabled ?? true`, so
 * turning on "require human approval" ALSO enabled platform-wide auto rules.
 * The console default (pages/super-admin.tsx) showed and re-sent auto rules
 * as true too.
 *
 * Drives the real route handler. Replaced: the DB (in-memory policy table
 * that records every write), the capability gate (requireCapability: the real
 * chain for this route is covered by closure013PlatformTierWriteSiblings),
 * the rate limiter, the GET read guard and the route factory.
 */

type Row = Record<string, unknown>;
const mockState: {
  rows: Row[];
  readError: unknown;
  readThrows: boolean;
  writes: { table: string; op: 'insert' | 'update'; payload: Row }[];
  policyReads: number;
} = { rows: [], readError: null, readThrows: false, writes: [], policyReads: 0 };

function mockBuilder(table: string) {
  let pending: { op: 'insert' | 'update'; payload: Row } | null = null;
  const b: Record<string, unknown> = {};
  const chain = () => b;
  const settle = async () => {
    if (pending) {
      mockState.writes.push({ table, ...pending });
      if (table !== 'community_ai_platform_policy') return { data: null, error: null };
      if (pending.op === 'insert') {
        const row = { id: 'policy-new', ...pending.payload };
        mockState.rows.push(row);
        return { data: row, error: null };
      }
      const row = mockState.rows[0];
      Object.assign(row, pending.payload);
      return { data: row, error: null };
    }
    if (table === 'community_ai_platform_policy') {
      mockState.policyReads += 1;
      if (mockState.readThrows) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      if (mockState.readError) return { data: null, error: mockState.readError };
      return { data: mockState.rows[0] ?? null, error: null };
    }
    return { data: null, error: null };
  };
  Object.assign(b, {
    select: chain, order: chain, limit: chain, eq: chain,
    insert: (p: Row) => { pending = { op: 'insert', payload: p }; return b; },
    update: (p: Row) => { pending = { op: 'update', payload: p }; return b; },
    maybeSingle: settle,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej),
  });
  return b;
}
const mockSupabase = { from: (t: string) => mockBuilder(t) };
jest.mock('../../db/supabaseClient', () => ({ supabase: mockSupabase, default: mockSupabase }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/requestAccessService', () => ({ requireAdminRateLimit: async () => true }));

/** Capability gate stand-in: only a request carrying x-test-role SUPER_ADMIN holds the capability. */
const mockCapabilityCalls: string[] = [];
jest.mock('../../security/requireCapability', () => ({
  requireCapability: async (
    req: { headers: Record<string, string> },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    opts: { capability: string },
  ) => {
    mockCapabilityCalls.push(opts.capability);
    if (req.headers['x-test-role'] !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'CAPABILITY_NOT_HELD' });
      return { ok: false };
    }
    return { ok: true, principal: { userId: 'u-super', email: 'super@example.test' } };
  },
}));
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: async (req: { headers: Record<string, string> }) =>
    req.headers['x-test-role'] ? { user: { id: `u-${req.headers['x-test-role']}`, email: null }, error: null } : { user: null, error: 'NO_TOKEN' },
}));
jest.mock('../../services/rbacService', () => ({
  isPlatformSuperAdmin: async (id: string) => id === 'u-SUPER_ADMIN',
}));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: () => null }));

import fs from 'fs';
import path from 'path';
import handler from '../../../pages/api/super-admin/community-ai-policy';
import { INTELLIGENCE_OVERRIDE_MANAGE } from '../../../shared/contracts/security';
import { PLATFORM_TIER_CAPABILITIES } from '../../security/platformCapabilities';

type Res = { statusCode: number; body: any } & Record<string, any>;
function fakeRes(): Res {
  const r = { statusCode: 200, body: undefined } as Res;
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.setHeader = () => r;
  return r;
}
async function call(method: string, body: unknown, role: string | null = 'SUPER_ADMIN') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (role) headers['x-test-role'] = role;
  const res = fakeRes();
  await (handler as unknown as (q: unknown, s: unknown) => Promise<unknown>)(
    { method, headers, body, query: {}, socket: {}, cookies: {} },
    res,
  );
  return res;
}
const policyWrites = () => mockState.writes.filter((w) => w.table === 'community_ai_platform_policy');

beforeEach(() => {
  mockState.rows = [];
  mockState.readError = null;
  mockState.readThrows = false;
  mockState.writes = [];
  mockState.policyReads = 0;
  mockCapabilityCalls.length = 0;
});

describe('F-1: first save with no policy row', () => {
  it('turning on "require human approval" does NOT enable auto rules', async () => {
    const res = await call('POST', { require_human_approval: true });
    expect(res.statusCode).toBe(200);
    expect(policyWrites()).toHaveLength(1);
    expect(policyWrites()[0].op).toBe('insert');
    expect(policyWrites()[0].payload).toMatchObject({
      require_human_approval: true,
      auto_rules_enabled: false,
      // Manual sends stay available: the live inbox is not silently disabled.
      execution_enabled: true,
    });
  });

  it('any partial first save leaves auto rules off and persists the runtime no-row defaults', async () => {
    const res = await call('POST', { execution_enabled: false });
    expect(res.statusCode).toBe(200);
    expect(policyWrites()[0].payload).toMatchObject({
      execution_enabled: false,
      auto_rules_enabled: false,
      require_human_approval: false,
    });
  });

  it('an explicit auto_rules_enabled: true is honoured', async () => {
    const res = await call('POST', { auto_rules_enabled: true });
    expect(res.statusCode).toBe(200);
    expect(policyWrites()[0].payload).toMatchObject({ auto_rules_enabled: true });
  });

  it('a non-boolean auto_rules_enabled is not an authorisation', async () => {
    const res = await call('POST', { auto_rules_enabled: 'true', require_human_approval: true });
    expect(res.statusCode).toBe(200);
    expect(policyWrites()[0].payload).toMatchObject({ auto_rules_enabled: false });
  });
});

describe('existing policy row', () => {
  it('a partial update preserves every field it does not name (auto rules ON stays ON)', async () => {
    mockState.rows = [{ id: 'policy-1', execution_enabled: false, auto_rules_enabled: true, require_human_approval: false }];
    const res = await call('POST', { require_human_approval: true });
    expect(res.statusCode).toBe(200);
    expect(policyWrites()).toHaveLength(1);
    expect(policyWrites()[0].op).toBe('update');
    expect(policyWrites()[0].payload).toMatchObject({
      execution_enabled: false,
      auto_rules_enabled: true,
      require_human_approval: true,
    });
  });

  it('a partial update preserves auto rules OFF and approval ON', async () => {
    mockState.rows = [{ id: 'policy-1', execution_enabled: true, auto_rules_enabled: false, require_human_approval: true }];
    const res = await call('POST', { execution_enabled: false });
    expect(res.statusCode).toBe(200);
    expect(policyWrites()[0].payload).toMatchObject({
      execution_enabled: false,
      auto_rules_enabled: false,
      require_human_approval: true,
    });
  });

  it('an explicit false switches auto rules off', async () => {
    mockState.rows = [{ id: 'policy-1', execution_enabled: true, auto_rules_enabled: true, require_human_approval: false }];
    await call('POST', { auto_rules_enabled: false });
    expect(policyWrites()[0].payload).toMatchObject({ auto_rules_enabled: false });
  });
});

describe('unreadable policy store', () => {
  it('POST refuses to write when the read errors', async () => {
    mockState.readError = { code: '57014', message: 'canceling statement due to statement timeout' };
    const res = await call('POST', { require_human_approval: true });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'FAILED_TO_LOAD_POLICY' });
    expect(mockState.policyReads).toBe(1); // scenario exists: the read happened and failed
    expect(policyWrites()).toHaveLength(0);
    expect(mockState.writes).toHaveLength(0);
  });

  it('POST refuses to write when the read throws', async () => {
    mockState.readThrows = true;
    const res = await call('POST', { require_human_approval: true });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'FAILED_TO_LOAD_POLICY' });
    expect(mockState.policyReads).toBe(1);
    expect(mockState.writes).toHaveLength(0);
  });

  it('GET reports the read failure instead of "no policy" (200 + null)', async () => {
    mockState.readError = { code: '57014', message: 'timeout' };
    const res = await call('GET', undefined);
    expect(mockState.policyReads).toBe(1);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'POLICY_UNREADABLE' });
  });

  it('GET with a successful empty read still answers 200 + null (control for the 503)', async () => {
    const res = await call('GET', undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ policy: null });
  });
});

describe('authorisation', () => {
  it('the mutation gate is the platform-tier INTELLIGENCE_OVERRIDE_MANAGE capability', () => {
    expect(PLATFORM_TIER_CAPABILITIES).toContain(INTELLIGENCE_OVERRIDE_MANAGE);
  });

  it('a super-admin save is allowed (role scenario exists)', async () => {
    const res = await call('POST', { auto_rules_enabled: false }, 'SUPER_ADMIN');
    expect(res.statusCode).toBe(200);
    expect(mockCapabilityCalls).toEqual([INTELLIGENCE_OVERRIDE_MANAGE]);
    expect(policyWrites()).toHaveLength(1);
  });

  it.each(['COMPANY_ADMIN', 'VIEW_ONLY', null])('POST by %s is refused before any policy read or write', async (role) => {
    const res = await call('POST', { auto_rules_enabled: true }, role);
    expect(res.statusCode).toBe(403);
    expect(mockCapabilityCalls).toEqual([INTELLIGENCE_OVERRIDE_MANAGE]);
    expect(mockState.policyReads).toBe(0);
    expect(mockState.writes).toHaveLength(0);
  });

  it('GET by a non-super-admin is refused', async () => {
    const res = await call('GET', undefined, 'COMPANY_ADMIN');
    expect(res.statusCode).toBe(401);
    expect(mockState.policyReads).toBe(0);
  });
});

describe('console defaults (pages/super-admin.tsx)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../pages/super-admin.tsx'), 'utf8');
  const defaultBlock = (src.match(/const defaultPolicy: CommunityAiPolicy = \{([\s\S]*?)\};/) ?? [])[1] ?? '';

  it('the no-row default shows auto rules OFF, manual execution ON (matches the runtime DEFAULT_POLICY)', () => {
    expect(defaultBlock).not.toBe('');
    expect(defaultBlock).toMatch(/auto_rules_enabled:\s*false/);
    expect(defaultBlock).toMatch(/execution_enabled:\s*true/);
  });

  it('a toggle save sends only the toggled field, never the whole (possibly default) view', () => {
    const save = (src.match(/const savePolicy = async \(\) => \{([\s\S]*?)\n {2}\};/) ?? [])[1] ?? '';
    expect(save).toContain("fetchWithAuth('/api/super-admin/community-ai-policy'");
    expect(save).toMatch(/JSON\.stringify\(\{ \[pendingPolicyKey\]: pendingPolicy\[pendingPolicyKey\] \}\)/);
    expect(save).not.toMatch(/auto_rules_enabled:\s*pendingPolicy\.auto_rules_enabled/);
  });

  it('a toggle is refused until the current policy has been read', () => {
    const open = (src.match(/const openPolicyConfirm = [\s\S]*?\n {2}\};/) ?? [])[0] ?? '';
    expect(open).toMatch(/if \(!communityPolicyLoaded\) \{[\s\S]*?return;/);
  });
});
