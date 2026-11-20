/**
 * Activity-workspace LIVE billing refusals (04, 2026-11-20). Harness copied from activityWorkspaceCreditAuthzSec001
 * (DB, auth, rate limit and the billing barrel faked; the handler runs for real).
 *   - refine_variant: a BillingRefusalError from runBilledAiCompletion used to fall to the generic 500 ("Failed to
 *     process activity content request"), so the user was never told about credits. Now: its status + code.
 *   - generate_master / improve_*: their 402/403 bodies now carry a code from shared/billing/billingRefusalCodes.ts
 *     (source contract below).
 */
export {};

const CO_A = 'co-a-0000-0000-0000-00000000000a';
const CO_B = 'co-b-0000-0000-0000-00000000000b';
const USER_A = 'user-a-00-0000-0000-00000000000a';

/** If company B is ever charged, this is what the sink will have received. */
const CANARY = CO_B;

const COMPANIES = [
  { id: CO_A, status: 'active', deleted_at: null },
  { id: CO_B, status: 'active', deleted_at: null },
];

/** USER_A is an ACTIVE member of A only. Other rows model the denial states. */
let roleRows: any[] = [];
const ACTIVE_IN_A = [{ user_id: USER_A, company_id: CO_A, role: 'COMPANY_ADMIN', status: 'active' }];

let calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
let authedUser: string | null = USER_A;

function rowsFor(table: string): any[] {
  if (table === 'user_company_roles') return roleRows;
  if (table === 'companies') return COMPANIES;
  // Activity/campaign fixtures: the activity belongs to company B, so the
  // server-side fallback resolves B too — it is not a safer source.
  if (table === 'daily_content_plans') return [{ id: 'act-b', campaign_id: 'camp-b' }];
  if (table === 'campaigns') return [{ id: 'camp-b', company_id: CO_B }];
  return [];
}

function makeBuilder(table: string) {
  const filters: Record<string, unknown> = {};
  const b: any = {};
  // SEC-91 W2-A (W2F-1a): the handler now resolves a saved activity with the
  // canonical writer's `.or(id.eq.X,execution_id.eq.X)` lookup before binding it
  // to the company, so the fake builder accepts `.or` (unfiltered, like `in`).
  for (const m of ['select', 'order', 'limit', 'in', 'neq', 'is', 'or', 'insert', 'update', 'upsert', 'delete']) b[m] = () => b;
  b.eq = (c: string, v: unknown) => { filters[c] = v; return b; };
  const resolve = () => {
    calls.push({ table, filters: { ...filters } });
    return {
      data: rowsFor(table).filter((r) =>
        Object.entries(filters).every(([k, v]) => (r as any)[k] === v)),
      error: null,
    };
  };
  b.maybeSingle = async () => ({ data: resolve().data[0] ?? null, error: null });
  b.single = async () => ({ data: resolve().data[0] ?? null, error: null });
  b.then = (ok: any, err: any) => Promise.resolve(resolve()).then(ok, err);
  return b;
}

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => makeBuilder(t) } }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => makeBuilder(t) }));

jest.mock('@/backend/services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () =>
    (authedUser ? { user: { id: authedUser, email: 'a@example.com' }, error: null }
                : { user: null, error: 'MISSING_AUTH' })),
}));

/* ── the consequential sinks: observed, never executed ────────────────────── */
const sinkReserved = jest.fn(async () => ({ platform: 'linkedin', generated_content: 'improved' }));
/*
 * Declared explicitly rather than via requireActual: the real module re-exports
 * the orchestration barrel, which constructs a BullMQ client at import time and
 * throws without REDIS_URL. Only the handler's own imports are reproduced here.
 */
jest.mock('../../services/activityWorkspace/contentRouteModel', () => ({
  runReservedFixedWorkflow: (...a: any[]) => (sinkReserved as any)(...a),
  asObject: (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null),
  persistMasterToDb: jest.fn(async () => {}),
  persistVariantsToDb: jest.fn(async () => {}),
  FAILED_VARIANT_PREFIXES: [] as string[],
  MonetizedWorkflowError: class MonetizedWorkflowError extends Error {
    status: number; payload: unknown;
    constructor(status: number, payload: unknown) { super('monetized'); this.status = status; this.payload = payload; }
  },
}));
jest.mock('@/backend/services/orchestration', () => ({
  updateExecutionContentByActivity: jest.fn(async () => {}),
  // 3AH-92 (S-2): the handler now resolves its write target through the
  // adapter. Mirrored over this suite's fixture: the fixture activity resolves
  // to its row, anything else is transient (no row), as in production.
  resolveActivityRow: jest.fn(async (id: string) => {
    const row = rowsFor('daily_content_plans').find((r) => r.id === id);
    return row ? { ok: true, row } : { ok: false, reason: 'row_not_found' };
  }),
}));

const sinkBilled = jest.fn(async () => ({ ok: true, content: 'refined', charged: true }));
const sinkRefineEnabled = jest.fn(async () => ({ enabled: true, reason: null }));
jest.mock('@/backend/services/billing', () => ({
  isRefineVariantBillingEnabled: (...a: any[]) => (sinkRefineEnabled as any)(...a),
  runBilledAiCompletion: (...a: any[]) => (sinkBilled as any)(...a),
}));

const sinkCompletion = jest.fn(async () => ({ content: 'direct' }));
jest.mock('@/backend/services/aiGateway', () => ({
  runCompletionWithOperation: (...a: any[]) => (sinkCompletion as any)(...a),
}));

/*
 * generate_master applies sliding-window rate limits after its own membership
 * check. Unmocked, that opens a Redis connection and the test HANGS rather than
 * fails — which also masks mutation results, because a mutation that turns a
 * denial into an approval reaches exactly this code. Stubbed permissive so the
 * authorization boundary is what the assertions measure.
 */
jest.mock('@/lib/auth/rateLimit', () => ({
  checkRateLimit: jest.fn(async () => ({ allowed: true, remaining: 100, resetSeconds: 60 })),
}));

import handler from '../../services/activityWorkspace/contentRouteHandler';

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: unknown) => { res.body = p; return res; };
  res.setHeader = () => res;
  return res;
}
const post = async (body: Record<string, unknown>) => {
  const res = mockRes();
  await handler({ method: 'POST', body, query: {}, headers: {} } as any, res);
  return res;
};

import fs from 'fs';
import path from 'path';
const { BillingRefusalError } = jest.requireActual('../../services/billing/runBilledAiCompletion');

const REFINE = {
  action: 'refine_variant', companyId: CO_A, platform: 'linkedin',
  refinement_prompt: 'tighten it', current_content: 'hello world',
  schedule: { platform: 'linkedin', contentType: 'post' },
};

beforeEach(() => {
  calls = [];
  authedUser = USER_A;
  roleRows = [...ACTIVE_IN_A];
  sinkBilled.mockReset();
  sinkRefineEnabled.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => (console.error as jest.Mock).mockRestore?.());

describe('refine_variant: a billing refusal answers its status + code (it used to be a generic 500)', () => {
  it.each<[string, number]>([['INSUFFICIENT_CREDITS', 402], ['NO_CREDIT_ACCOUNT', 402], ['ORG_SCOPE_VIOLATION', 403], ['ORG_CONTROL_BLOCKED', 403]])(
    '%s → %d', async (code, status) => {
      sinkBilled.mockImplementation(async () => { throw new BillingRefusalError(code, 'x'); });
      const res = await post(REFINE);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ error: 'Billing refused', code });
    });

  it('control: a NON-billing failure keeps the generic 500', async () => {
    sinkBilled.mockImplementation(async () => { throw new Error('upstream boom'); });
    const res = await post(REFINE);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to process activity content request' });
  });
});

describe('source contract: every billing 402/403 in the activity-workspace route carries a code', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('contentRouteHandler: the generate_master refusals (insufficient / no account / not a member / control) carry codes', () => {
    const src = read('backend/services/activityWorkspace/contentRouteHandler.ts');
    expect(src).toMatch(/error:\s+'Insufficient credits to generate content',\s+code:\s+'INSUFFICIENT_CREDITS'/);
    expect(src).toMatch(/error: 'No credit account for org', code: 'NO_CREDIT_ACCOUNT'/);
    expect(src).toMatch(/result\.status === 'not_a_member'\) \{\s+return res\.status\(403\)\.json\(\{ error: 'ORG_SCOPE_VIOLATION', code: 'ORG_SCOPE_VIOLATION' \}\)/);
    expect(src).toMatch(/error: result\.code, code: 'ORG_CONTROL_BLOCKED'/);
  });

  it('contentRouteModel: every MonetizedWorkflowError 402/403 carries a code (count control: 4)', () => {
    const src = read('backend/services/activityWorkspace/contentRouteModel.ts');
    const lines = src.split(/\r?\n/);
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /MonetizedWorkflowError\((402|403)/.test(l));
    expect(sites).toHaveLength(4);
    for (const { i } of sites) {
      const window = lines.slice(i, i + 4).join(' ');
      expect({ line: i + 1, coded: /code: '(INSUFFICIENT_CREDITS|NO_CREDIT_ACCOUNT|ORG_SCOPE_VIOLATION|ORG_CONTROL_BLOCKED)'/.test(window) })
        .toMatchObject({ coded: true });
    }
  });
});
