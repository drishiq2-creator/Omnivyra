/**
 * Pins the in-memory harness's model of community_ai_claim_within_limits (migration 20270217000021) and of a
 * PostgREST count select, so the fake cannot drift from the SQL it stands in for (7c review of 0678f970a).
 * Every case calls the harness fake directly; the SQL itself is proven in the real-schema suites.
 */
export {};
import {
  actionStore, buildQuery, communityRpc, refusalStore, resetCommunityAiStores, seedExecutionPolicy,
  setGuardrailRow, storeApproved, DEFAULT_GUARDRAIL_ROW,
} from './communityAiTestHarness';

const ARGS = { p_org: 'tenant-1', p_tenant: 'tenant-1', p_claim_point: 'scheduler', p_execution_mode: 'api', p_correlation_id: null };
const claim = (id: string, source = 'scheduler') =>
  communityRpc('community_ai_claim_within_limits', { ...ARGS, p_action_id: id, p_source: source }) as Promise<{ data: any; error: any }>;
const action = (id: string, over: Record<string, any> = {}) => storeApproved({
  id, tenant_id: 'tenant-1', organization_id: 'tenant-1', platform: 'reddit', action_type: 'reply', target_id: 't-1', ...over,
});

beforeEach(() => { resetCommunityAiStores(); seedExecutionPolicy(); });

describe('community_ai_claim_within_limits (fake) mirrors the SQL', () => {
  it('approved, under every limit: delegates to the plain claim and claims', async () => {
    action('a1');
    const r = await claim('a1');
    expect(r.error).toBeNull();
    expect(r.data[0]).toEqual({ claimed: true, code: null, current_status: 'executing' });
    expect(actionStore.get('a1').status).toBe('executing');
  });

  it('approved, per-post limit reached: GUARDRAIL_PER_POST_LIMIT, one refusal record, nothing claimed', async () => {
    setGuardrailRow({ ...DEFAULT_GUARDRAIL_ROW, per_post_reply_limit: 1 });
    action('a0', { status: 'executed', executed_at: new Date().toISOString() });
    action('a1');
    const r = await claim('a1');
    expect(r.data[0]).toEqual({ claimed: false, code: 'GUARDRAIL_PER_POST_LIMIT', current_status: 'approved' });
    expect(refusalStore.filter((x) => x.action_id === 'a1')).toHaveLength(1);
    expect(actionStore.get('a1').status).toBe('approved');
  });

  it('an in-flight (executing) action counts against the limit too', async () => {
    setGuardrailRow({ ...DEFAULT_GUARDRAIL_ROW, daily_platform_limit: 1 });
    action('a0', { status: 'executing', target_id: 't-other' });
    action('a1');
    expect((await claim('a1')).data[0].code).toBe('GUARDRAIL_DAILY_PLATFORM_LIMIT');
  });

  it('7c FINDING: a NON-approved action delegates (the claim answers), never a GUARDRAIL_* refusal', async () => {
    setGuardrailRow({ ...DEFAULT_GUARDRAIL_ROW, per_post_reply_limit: 0, daily_platform_limit: 0 });
    action('a1', { status: 'executing' });
    const r = await claim('a1');
    expect(r.data[0].code).toBe('CLAIM_CONFLICT');
    expect(String(r.data[0].code)).not.toMatch(/^GUARDRAIL_/);
  });

  it('NO guardrail row: no limits at all (the SQL\'s IF FOUND), and the select answers no row', async () => {
    setGuardrailRow(null);
    action('a0', { status: 'executed', executed_at: new Date().toISOString() });
    action('a1');
    expect((await claim('a1')).data[0].claimed).toBe(true);
    const sel = await buildQuery('execution_guardrails').select('*').eq('company_id', 'tenant-1').maybeSingle();
    expect(sel).toEqual({ data: null, error: null });
  });

  it('an auto-disabled guardrail refuses with GUARDRAIL_AUTO_DISABLED', async () => {
    setGuardrailRow({ ...DEFAULT_GUARDRAIL_ROW, auto_execution_enabled: false });
    action('a1');
    expect((await claim('a1')).data[0].code).toBe('GUARDRAIL_AUTO_DISABLED');
  });

  it('a bad p_source is an RPC ERROR (the SQL raises 22023), not a refusal row', async () => {
    action('a1');
    const r = await claim('a1', 'auto');
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('22023');
  });

  it('resetCommunityAiStores restores the default guardrail row', async () => {
    setGuardrailRow(null);
    resetCommunityAiStores();
    const sel = await buildQuery('execution_guardrails').select('*').eq('company_id', 'tenant-1').maybeSingle();
    expect(sel.data).toEqual({ ...DEFAULT_GUARDRAIL_ROW });
  });
});

describe('a PostgREST count select (fake)', () => {
  it("select('id', { count: 'exact', head: true }) answers { data: null, count: n }", async () => {
    action('a1', { status: 'executing' });
    action('a2', { status: 'executing' });
    action('a3');
    const r: any = await buildQuery('community_ai_actions').select('id', { count: 'exact', head: true }).eq('status', 'executing');
    expect(r).toEqual({ data: null, count: 2, error: null });
  });

  it('without head, the rows come back WITH the count', async () => {
    action('a1', { status: 'executing' });
    const r: any = await buildQuery('community_ai_actions').select('id', { count: 'exact' }).eq('status', 'executing');
    expect(r.count).toBe(1);
    expect(r.data).toHaveLength(1);
  });

  it('a plain select is unchanged (no count key)', async () => {
    action('a1');
    const r: any = await buildQuery('community_ai_actions').select('*').eq('status', 'approved');
    expect(r).not.toHaveProperty('count');
    expect(r.data).toHaveLength(1);
  });
});
