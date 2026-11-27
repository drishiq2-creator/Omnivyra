/**
 * Round 24D / G-7 — contact governance at the execute ROUTE and at the
 * extension command HAND-OUT (the last point before the browser sends).
 *
 * The suppression engine (`isSuppressed` + `mayContact`) is real; only the
 * table layer is an in-memory double. The executor itself is a spy here: the
 * execute route must refuse BEFORE the state transition and before the
 * executor is reached. Every refusal has a control that differs only by the
 * suppression row / store failure and must proceed.
 */

type Row = Record<string, any>;
type Filter = [kind: string, column: string, value: unknown];

const gov = {
  tables: {} as Record<string, Row[]>,
  failures: {} as Record<string, { code: string; message: string }>,
  queries: [] as Array<{ table: string; filters: Filter[] }>,
};

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const filters: Filter[] = [];
    const match = (r: Row): boolean =>
      filters.every(([kind, col, val]) => {
        if (kind === 'eq') return r[col] === val;
        if (kind === 'is') return (r[col] ?? null) === val;
        if (kind === 'in') return Array.isArray(val) && (val as unknown[]).includes(r[col] ?? null);
        return true;
      });
    const exec = async (mode: 'many' | 'maybe') => {
      await Promise.resolve();
      gov.queries.push({ table, filters });
      const failure = gov.failures[table];
      if (failure) return { data: null, error: failure };
      const found = (gov.tables[table] ?? []).filter(match);
      return mode === 'many' ? { data: found, error: null } : { data: found[0] ?? null, error: null };
    };
    const b: any = {
      select: () => b,
      insert: () => b,
      eq: (c: string, v: unknown) => { filters.push(['eq', c, v]); return b; },
      is: (c: string, v: unknown) => { filters.push(['is', c, v]); return b; },
      in: (c: string, v: unknown) => { filters.push(['in', c, v]); return b; },
      order: () => b,
      limit: () => exec('many'),
      maybeSingle: () => exec('maybe'),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec('many').then(res, rej),
    };
    return b;
  },
}));

// ── community_ai_actions + policy via supabase (route-side) ─────────────────
const store: { actions: Row[]; updates: Array<{ id?: unknown; payload: Row }> } = { actions: [], updates: [] };

function actionsQuery() {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const q: any = {
    select: () => q,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
    is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return q; },
    in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return q; },
    gte: () => q,
    or: () => { filters.push((r) => r.dispatch_lease_expires_at == null); return q; },
    order: () => q,
    limit: () => q,
    update: (p: Row) => { patch = p; return q; },
    maybeSingle: async () => {
      const hit = store.actions.find((r) => filters.every((f) => f(r)));
      if (hit && patch) { Object.assign(hit, patch); store.updates.push({ id: hit.id, payload: patch }); }
      return { data: hit ? { ...hit } : null, error: null };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: store.actions.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }).then(ok, ko),
  };
  return q;
}
const from = (t: string) => {
  if (t === 'community_ai_actions' || t === 'community_ai_action_logs') return actionsQuery();
  const q: any = { update: () => q, eq: () => q, select: () => q, limit: async () => ({ data: [{ id: 's' }], error: null }), insert: async () => ({ error: null }) };
  return q;
};
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => from(t) } }));

// Round 28: the real fail-closed evaluator decides over this value (configured row unless stated).
jest.mock('../../services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })));
// Round 28: the real fail-closed evaluator decides over this value (configured row unless stated).
jest.mock('@/backend/services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })));
jest.mock('../../db/communityAiActionStore', () => ({
  getCommunityAiActionById: jest.fn(async (id: string) => {
    const hit = store.actions.find((r) => r.id === id);
    return hit ? { data: { ...hit }, error: null } : { data: null, error: new Error('nf') };
  }),
}));
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: jest.fn(async (req: any) => ({ tenantId: req.__org, organizationId: req.__org })),
  enforceActionRole: jest.fn(async () => ({ userId: 'user-1', role: 'COMPANY_ADMIN' })),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/communityAiActionExecutor', () => ({
  executeAction: jest.fn(async () => ({ ok: true, status: 'executed' })),
}));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => ({ id: 'pb-1' })) }));
jest.mock('../../services/playbooks/playbookValidator', () => ({ validateActionAgainstPlaybook: jest.fn(() => ({ allowed: true })) }));

// ── extension hand-out collaborators ────────────────────────────────────────
jest.mock('@/backend/middleware/extensionAuthMiddleware', () => ({
  requireExtensionAuth: async () => ({ session: { userId: 'user-1', orgId: currentOrg.value, hmacNonce: 'nonce' } }),
}));
jest.mock('@/backend/services/engagementCapabilityMap', () => ({
  CAPABILITY_MAP_VERSION: 'cap-test', resolveEngagementCapability: () => ({ status: 'api_verified' }),
}));
jest.mock('@/backend/services/extensionReliabilityService', () => ({ isCurrentlyDisabled: () => false }));
jest.mock('@/backend/services/extensionCommandSchema', () => ({
  COMMAND_SCHEMA_VERSION: 'schema-test', validateCommandPayload: (_p: string, _a: string, payload: Row) => ({ ok: true, payload }),
}));
const persisted: Row[] = [];
jest.mock('@/backend/services/communityAiExecutionResultService', () => ({
  recordExecutionMetric: async () => undefined,
  persistExecutionResult: async (input: Row) => { persisted.push(input); return { ok: true }; },
}));
jest.mock('@/backend/services/rpaWorker/rpaAccountTier', () => ({ resolveAccountTier: async () => 'business' }));

const currentOrg = { value: '' };

import executeRoute from '../../../pages/api/community-ai/actions/execute';
import commandsRoute from '../../../pages/api/extension/commands';
import { executeAction } from '../../services/communityAiActionExecutor';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const PROFILE = 'https://www.linkedin.com/in/Jane-Doe';

const govRow = (over: Row = {}): Row => ({
  id: `g-${Math.random()}`, organization_id: ORG_A, person_id: null, target_normalized: PROFILE.toLowerCase(),
  channel: 'linkedin', governance_type: 'unsubscribe',
  effective_from: '2026-01-01T00:00:00.000Z', effective_until: null, revoked_at: null, purpose_scope: null,
  ...over,
});
const suppress = (over: Row = {}) => { gov.tables.contact_governance_records.push(govRow(over)); };

const row = (over: Row = {}): Row => ({
  id: 'act-1', tenant_id: ORG_A, organization_id: ORG_A, platform: 'linkedin', action_type: 'dm',
  target_id: PROFILE, suggested_text: 'Hello Jane', playbook_id: 'pb-1', execution_mode: 'browser',
  status: 'approved', requires_human_approval: true, approved_at: '2026-11-01T00:00:00Z', risk_level: 'low',
  metadata: null, created_at: '2026-11-01T00:00:00Z', dispatch_lease_id: null, dispatch_lease_expires_at: null,
  execution_correlation_id: 'corr-1', command_chain: null, command_chain_index: 0,
  ...over,
});

async function call(route: any, req: Row) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await route({ headers: {}, query: {}, body: {}, ...req }, res);
  return res;
}
const execute = (org: string, body: Row = { action_id: 'act-1', approved: true }) => call(executeRoute, { method: 'POST', body, __org: org });
const poll = async (org: string) => {
  currentOrg.value = org;
  const res = await call(commandsRoute, { method: 'GET', headers: { 'x-omnivyra-capability-version': 'cap-test' } });
  return { status: res.statusCode, ids: (res.body?.commands ?? []).map((c: Row) => c.id) as string[] };
};
const transitioned = () => store.updates.some((u) => u.payload.status === 'executing');
const claimed = (id: string) => store.actions.find((r) => r.id === id)?.dispatch_lease_id != null;

beforeEach(() => {
  jest.clearAllMocks();
  gov.tables = { contact_governance_records: [], suppression_entries: [], identity_claims: [] };
  gov.failures = {};
  gov.queries = [];
  store.actions = [];
  store.updates = [];
  persisted.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('execute route', () => {
  it('a suppressed recipient: 403 CONTACT_SUPPRESSED, no state transition, executor never reached', async () => {
    suppress();
    store.actions = [row()];
    const res = await execute(ORG_A);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'CONTACT_SUPPRESSED', reason: 'unsubscribe' });
    expect(transitioned()).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('CONTROL: a non-suppressed recipient transitions and reaches the executor', async () => {
    store.actions = [row()];
    const res = await execute(ORG_A);
    expect(res.statusCode).toBe(200);
    expect(transitioned()).toBe(true);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it('a suppressed DM thread in metadata is refused here (the executor is handed no metadata)', async () => {
    const thread = 'https://www.linkedin.com/messaging/thread/2-abc/';
    suppress({ target_normalized: thread.toLowerCase() });
    store.actions = [row({ metadata: { dm_thread_ready: true, dm_thread_url: thread } })];
    const res = await execute(ORG_A);
    expect(res.statusCode).toBe(403);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("cross-tenant: tenant A's suppression does not block tenant B", async () => {
    suppress({ organization_id: ORG_A });
    store.actions = [row({ tenant_id: ORG_B, organization_id: ORG_B })];
    const res = await execute(ORG_B);
    expect(res.statusCode).toBe(200);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it('unreadable governance store: 503 CONTACT_GOVERNANCE_UNAVAILABLE, nothing sent or transitioned', async () => {
    gov.failures.contact_governance_records = { code: '42501', message: 'permission denied' };
    store.actions = [row()];
    const res = await execute(ORG_A);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'CONTACT_GOVERNANCE_UNAVAILABLE', reason: 'governance_lookup_failed_failclosed' });
    expect(transitioned()).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
  });
});

describe('extension command hand-out', () => {
  const handoutRow = (over: Row = {}) => row({ status: 'pending', ...over });

  it('a recipient suppressed after preparation is not handed out; the row is terminalized blocked', async () => {
    suppress();
    store.actions = [handoutRow()];
    expect(await poll(ORG_A)).toEqual({ status: 200, ids: [] });
    expect(claimed('act-1')).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      actionId: 'act-1', organizationId: ORG_A, expectedFromStatuses: ['pending'],
      result: { status: 'skipped', reason: 'CONTACT_SUPPRESSED' },
    });
    expect(persisted[0].rowHint).toBeUndefined();
  });

  it('CONTROL: a non-suppressed recipient is handed out and claimed', async () => {
    store.actions = [handoutRow()];
    expect(await poll(ORG_A)).toEqual({ status: 200, ids: ['act-1'] });
    expect(claimed('act-1')).toBe(true);
    expect(persisted).toHaveLength(0);
  });

  it('a later chain step (continue_thread) is re-checked', async () => {
    suppress();
    store.actions = [handoutRow({
      command_chain: [{ action_type: 'open_thread', payload: {} }, { action_type: 'continue_thread', payload: { text: 'hi' } }],
      command_chain_index: 1,
    })];
    expect((await poll(ORG_A)).ids).toEqual([]);
  });

  it("cross-tenant: tenant A's suppression does not hold tenant B's command", async () => {
    suppress({ organization_id: ORG_A });
    store.actions = [handoutRow({ tenant_id: ORG_B, organization_id: ORG_B })];
    expect((await poll(ORG_B)).ids).toEqual(['act-1']);
  });

  it('unreadable governance store: the command is left UNCLAIMED and not terminalized', async () => {
    gov.failures.identity_claims = { code: '42501', message: 'permission denied' };
    store.actions = [handoutRow()];
    expect((await poll(ORG_A)).ids).toEqual([]);
    expect(claimed('act-1')).toBe(false);
    expect(persisted).toHaveLength(0);
  });

  it('CONTROL: an inbox sync (read-only step) is never gated by contact governance', async () => {
    gov.failures.contact_governance_records = { code: '42501', message: 'permission denied' };
    store.actions = [handoutRow({
      target_id: 'sync-dm-inbox:linkedin', suggested_text: null,
      command_chain: [{ action_type: 'sync_dm_inbox', payload: { navigate: true } }],
    })];
    await poll(ORG_A);
    expect(gov.queries.filter((q) => q.table === 'contact_governance_records')).toHaveLength(0);
  });
});
