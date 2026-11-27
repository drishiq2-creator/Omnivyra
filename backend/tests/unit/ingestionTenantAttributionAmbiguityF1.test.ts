/**
 * FIX-1 (owner 2026-11-27) — ingested engagement is attributed to ONE company
 * established by the post's own bindings, or to nobody (the unified sync is
 * skipped; post_comments are kept).
 *
 * THE DEFECT
 * ----------
 * `resolveIngestTenant` returned the campaign company when there was one, and
 * otherwise read
 *
 *     user_company_roles ... .eq('user_id', post.user_id).eq('status','active')
 *       .limit(1).maybeSingle()
 *
 * i.e. an ARBITRARY company when the post author is active in several. The
 * connected social account's company was never consulted, so a post published
 * from company A's account under company B's campaign was attributed to B. And a
 * post nobody owned was synced with organization_id NULL (an orphan thread).
 *
 * THE RULE PINNED HERE
 * --------------------
 *   campaign company + account company, both present and different -> refused
 *   both equal / exactly one present                                -> resolved
 *   neither -> the author's ACTIVE roles: exactly one company       -> resolved
 *                                         two or more               -> refused
 *                                         none                      -> unowned (skipped)
 *   account row missing / company id malformed                      -> refused
 *   any read error                                                  -> lookup_failed (skipped)
 *
 * Every non-resolved state: NO syncFromPostComments call (so no engagement_threads
 * or engagement_messages write and never a null-org write), post_comments still
 * persisted, a structured log with a reason code, and `attribution_skipped` on
 * the result.
 */

export {};

jest.mock('@/config', () => ({ config: {}, getValidatedConfig: () => ({}) }));

const mockResolveCampaignCompanyId = jest.fn();
const mockSyncFromPostComments = jest.fn();
const mockGetToken = jest.fn();
const mockGetScheduledPost = jest.fn();
const mockAdapterFetch = jest.fn();

/** Rows the `user_company_roles` read can see for the post author (ACTIVE only). */
let activeRoleRows: Array<{ company_id: unknown }> = [];
let roleLookupError: { message: string } | null = null;
/** The `limit(n)` the service passed to the role read, if it read roles at all. */
let roleLimitArgs: number[] = [];

/** The `social_accounts` row for the post's account: undefined = no such row. */
let accountRow: { company_id: unknown } | undefined = { company_id: null };
let accountLookupError: { message: string } | null = null;

/** Every table the attribution path touched, in order. */
let tablesRead: string[] = [];
let postCommentUpserts: Record<string, unknown>[][] = [];
let scheduledPostsForCycle: Array<{ id: string; platform: string }> = [];

function fakeTable(table: string): any {
  tablesRead.push(table);
  if (table === 'post_comments') {
    return {
      upsert: async (rows: Record<string, unknown>[]) => {
        postCommentUpserts.push(rows);
        return { data: rows, error: null };
      },
      select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }),
    };
  }
  if (table === 'user_company_roles') {
    // Faithful to PostgREST: `.limit(n)` is awaitable (a list of at most n rows)
    // AND chainable into `.maybeSingle()` (the first of those rows). The old
    // code's `.limit(1).maybeSingle()` therefore runs here unchanged, which is
    // what lets this file be a failing control against it.
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: (n: number) => {
              roleLimitArgs.push(n);
              const result = roleLookupError
                ? { data: null, error: roleLookupError }
                : { data: activeRoleRows.slice(0, n), error: null };
              return {
                then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
                maybeSingle: async () =>
                  roleLookupError
                    ? { data: null, error: roleLookupError }
                    : { data: activeRoleRows.slice(0, n)[0] ?? null, error: null },
              };
            },
          }),
        }),
      }),
    };
  }
  if (table === 'social_accounts') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            accountLookupError ? { data: null, error: accountLookupError } : { data: accountRow ?? null, error: null },
        }),
      }),
    };
  }
  if (table === 'scheduled_posts') {
    const q: any = {};
    for (const m of ['select', 'eq', 'not']) q[m] = () => q;
    q.gte = async () => ({ data: scheduledPostsForCycle, error: null });
    return q;
  }
  throw new Error(`unexpected table in ingestion path: ${table}`);
}

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => fakeTable(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => fakeTable(t) } }));
jest.mock('../../services/campaignAccessService', () => ({
  resolveCampaignCompanyId: (...a: any[]) => mockResolveCampaignCompanyId(...a),
}));
jest.mock('../../services/engagementNormalizationService', () => ({
  syncFromPostComments: (...a: any[]) => mockSyncFromPostComments(...a),
}));
jest.mock('../../auth/tokenStore', () => ({
  getToken: (...a: any[]) => mockGetToken(...a),
  isTokenExpiringSoon: () => false,
  markSocialAccountNeedsReauth: jest.fn(),
}));
jest.mock('../../auth/tokenRefresh', () => ({ refreshPlatformToken: jest.fn() }));
jest.mock('../../db/queries', () => ({ getScheduledPost: (...a: any[]) => mockGetScheduledPost(...a) }));
jest.mock('../../services/platformAdapters', () => ({
  getPlatformAdapter: () => ({ fetchComments: (...a: any[]) => mockAdapterFetch(...a) }),
}));
jest.mock('../../services/platformRegistryService', () => ({ getPlatformCategory: () => 'social' }));
jest.mock('../../services/engagementEvaluationService', () => ({ evaluatePostEngagement: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/creator/strategyAnalyticsRuntime', () => ({
  recordCommentStrategyEvents: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../scheduler/schedulerBatching', () => ({
  getSchedulerConcurrency: () => 1,
  mapWithConcurrency: async (list: any[], _c: number, fn: (x: any) => Promise<any>) => {
    const out = [];
    for (const x of list) {
      try { out.push({ ok: true, value: await fn(x) }); } catch (e) { out.push({ ok: false, error: e }); }
    }
    return out;
  },
}));

let svc: typeof import('../../services/engagementIngestionService');
beforeAll(async () => {
  svc = await import('../../services/engagementIngestionService');
});

const ONE_COMMENT = { data: [{ id: 'c1', text: 'hello', author_id: 'a1', created_at: '2026-01-01T00:00:00Z' }] };
const CO_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const CO_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';

const basePost = (over: Record<string, unknown> = {}) => ({
  id: 'p1', platform: 'x', platform_post_id: 't1',
  social_account_id: 'acct-1', campaign_id: 'camp-1', user_id: 'user-1',
  ...over,
});

/** organization_id actually handed to the unified persistence layer. */
const syncedOrgIds = () => mockSyncFromPostComments.mock.calls.map((c) => c[1].organization_id);

let errorLogs: unknown[][] = [];
let warnLogs: unknown[][] = [];
const skipLine = (code: string) =>
  [...errorLogs, ...warnLogs].find((a) => (a[1] as any)?.reason_code === code) as unknown[] | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  activeRoleRows = [];
  roleLookupError = null;
  roleLimitArgs = [];
  accountRow = { company_id: null };
  accountLookupError = null;
  tablesRead = [];
  postCommentUpserts = [];
  errorLogs = [];
  warnLogs = [];
  scheduledPostsForCycle = [];
  mockGetScheduledPost.mockResolvedValue(basePost());
  mockGetToken.mockResolvedValue({ access_token: 'tok', refresh_token: 'r', is_active: true });
  mockAdapterFetch.mockResolvedValue(ONE_COMMENT);
  mockResolveCampaignCompanyId.mockResolvedValue(null);
  mockSyncFromPostComments.mockResolvedValue({ synced: 1, errors: 0 });
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errorLogs.push(a); });
  jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnLogs.push(a); });
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

/** The common "skipped safely" postcondition. */
async function expectSkipped(code: string, candidateCount: number) {
  const r = await svc.ingestComments('p1');
  expect(r).toEqual({ success: true, ingested: 1, attribution_skipped: code });
  expect(mockSyncFromPostComments).not.toHaveBeenCalled();
  expect(syncedOrgIds()).not.toContain(null);
  // The canonical rows are still kept, so a later cycle can sync them.
  expect(postCommentUpserts).toHaveLength(1);
  const line = skipLine(code);
  expect(line).toBeDefined();
  // Ids and counts only: no names, no comment text.
  expect(Object.keys(line![1] as object).sort()).toEqual(
    (code === 'lookup_failed'
      ? ['platform', 'reason', 'reason_code', 'scheduled_post_id']
      : ['candidate_count', 'platform', 'reason_code', 'scheduled_post_id']).sort(),
  );
  expect(line![1]).toMatchObject({ scheduled_post_id: 'p1', platform: 'x' });
  if (code !== 'lookup_failed') expect((line![1] as any).candidate_count).toBe(candidateCount);
  expect(JSON.stringify(line)).not.toContain('hello');
}

// ─────────────────────────────────────────────────────────────────────────────
describe('1 — one unambiguous company: attribution preserved', () => {
  it('campaign company only (legacy account with company_id NULL) -> that company', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_A);
    accountRow = { company_id: null };
    const r = await svc.ingestComments('p1');
    expect(r).toEqual({ success: true, ingested: 1 });
    expect(syncedOrgIds()).toEqual([CO_A]);
  });

  it('account company only (no campaign) -> that company, without consulting author roles', async () => {
    mockGetScheduledPost.mockResolvedValue(basePost({ campaign_id: null }));
    accountRow = { company_id: CO_A };
    activeRoleRows = [{ company_id: CO_B }];
    const r = await svc.ingestComments('p1');
    expect(r).toEqual({ success: true, ingested: 1 });
    expect(syncedOrgIds()).toEqual([CO_A]);
    expect(tablesRead).not.toContain('user_company_roles');
  });

  it('campaign company == account company -> that company', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_A);
    accountRow = { company_id: CO_A };
    await svc.ingestComments('p1');
    expect(syncedOrgIds()).toEqual([CO_A]);
  });

  it('neither, and the author is active in exactly ONE company -> that company', async () => {
    activeRoleRows = [{ company_id: CO_B }];
    expect(activeRoleRows).toHaveLength(1);
    await svc.ingestComments('p1');
    expect(syncedOrgIds()).toEqual([CO_B]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 — multiple possible companies: not attributed', () => {
  it('CRITICAL: author active in 2 companies, no campaign/account company -> refused', async () => {
    activeRoleRows = [{ company_id: CO_A }, { company_id: CO_B }];
    // The scenario must EXIST before its refusal means anything.
    expect(new Set(activeRoleRows.map((r) => r.company_id)).size).toBe(2);

    await expectSkipped('multiple_author_companies', 2);
    // The read must be able to SEE a second company (not limit(1)).
    expect(roleLimitArgs.length).toBe(1);
    expect(roleLimitArgs[0]).toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL: campaign company != account company -> refused', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_B);
    accountRow = { company_id: CO_A };
    expect(CO_A).not.toBe(CO_B);

    await expectSkipped('campaign_account_company_mismatch', 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 — no company match: safe skip, never a null-org write', () => {
  it('CRITICAL: unowned -> no syncToUnifiedEngagement call, no null organization_id', async () => {
    expect(activeRoleRows).toHaveLength(0);
    await expectSkipped('unowned', 0);
  });

  it('unowned is still announced as "no owning company" (warning, not error)', async () => {
    await svc.ingestComments('p1');
    expect(warnLogs.some((a) => String(a[0]).includes('no owning company'))).toBe(true);
    expect(errorLogs.find((a) => (a[1] as any)?.reason_code === 'unowned')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 — missing/malformed identity: safe skip', () => {
  it('CRITICAL: the post names a social account whose row does not exist -> refused', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_A);
    accountRow = undefined;
    await expectSkipped('social_account_not_found', 0);
  });

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['a number', 42],
    ['an object', { id: CO_A }],
  ])('account company_id that is %s -> refused as malformed', async (_label, bad) => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_A);
    accountRow = { company_id: bad };
    await expectSkipped('malformed_company_id', 0);
  });

  it('an author role row with a malformed company id -> refused, not attributed', async () => {
    activeRoleRows = [{ company_id: '' }];
    await expectSkipped('malformed_company_id', 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5 — tenant isolation', () => {
  it('CRITICAL: company A\'s account under company B\'s campaign reaches NEITHER tenant', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_B);
    accountRow = { company_id: CO_A };
    await svc.ingestComments('p1');
    expect(syncedOrgIds()).not.toContain(CO_B);
    expect(syncedOrgIds()).not.toContain(CO_A);
    expect(mockSyncFromPostComments).not.toHaveBeenCalled();
  });

  it('CRITICAL: account A alone -> org A is what the sync receives, even if the author is also in B', async () => {
    mockGetScheduledPost.mockResolvedValue(basePost({ campaign_id: null }));
    accountRow = { company_id: CO_A };
    activeRoleRows = [{ company_id: CO_B }, { company_id: CO_A }];
    expect(activeRoleRows).toHaveLength(2);
    await svc.ingestComments('p1');
    expect(syncedOrgIds()).toEqual([CO_A]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6 — read error -> lookup_failed (unchanged semantics)', () => {
  it('a user_company_roles read error -> lookup_failed, skipped, reason survives', async () => {
    roleLookupError = { message: 'canceling statement due to statement timeout' };
    await expectSkipped('lookup_failed', 0);
    const line = errorLogs.find((a) => String(a[0]).includes('tenant attribution failed'));
    expect(JSON.stringify(line)).toContain('statement timeout');
  });

  it('CRITICAL: a social_accounts read error -> lookup_failed, never falls through to the campaign', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_A);
    accountLookupError = { message: 'connection reset' };
    await expectSkipped('lookup_failed', 0);
    expect(syncedOrgIds()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('7 — observable at the cycle level', () => {
  it('the cycle log counts skipped attributions by reason code; the posts still count as succeeded', async () => {
    scheduledPostsForCycle = [{ id: 'p1', platform: 'x' }, { id: 'p2', platform: 'x' }];
    mockGetScheduledPost.mockImplementation(async (id: string) => basePost({ id }));
    activeRoleRows = [{ company_id: CO_A }, { company_id: CO_B }];
    const infos: unknown[][] = [];
    (console.info as jest.Mock).mockImplementation((...a: unknown[]) => { infos.push(a); });

    const r = await svc.ingestRecentPublishedPosts();

    expect(r.summary.succeeded).toBe(2);
    const done = infos.find((a) => String(a[0]).includes('ingestRecentPublishedPosts completed'));
    expect(done).toBeDefined();
    expect((done![1] as any).attribution_skipped).toEqual({ multiple_author_companies: 2 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// N-1 (Track D, 2026-11-28): evaluatePostEngagement derives its company from
// the campaign ALONE and writes AI actions / runs auto-rules under it. When
// attribution was refused, unowned or unreadable, running it anyway acts on the
// engagement under a company the ingestion just declined to name.
describe('8 — N-1: AI evaluation only runs for an attributed post', () => {
  const evaluate = () =>
    (jest.requireMock('../../services/engagementEvaluationService') as { evaluatePostEngagement: jest.Mock })
      .evaluatePostEngagement;

  it('CONTROL: resolved (campaign == account company) -> evaluated once', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_A);
    accountRow = { company_id: CO_A };
    await svc.ingestComments('p1');
    expect(syncedOrgIds()).toEqual([CO_A]);
    expect(evaluate()).toHaveBeenCalledTimes(1);
    expect(evaluate()).toHaveBeenCalledWith('p1');
  });

  it('CRITICAL: campaign company != account company (refused) -> NOT evaluated', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_B);
    accountRow = { company_id: CO_A };
    await svc.ingestComments('p1');
    expect(mockSyncFromPostComments).not.toHaveBeenCalled();
    expect(evaluate()).not.toHaveBeenCalled();
  });

  it('CRITICAL: author active in 2 companies (refused) -> NOT evaluated', async () => {
    activeRoleRows = [{ company_id: CO_A }, { company_id: CO_B }];
    await svc.ingestComments('p1');
    expect(evaluate()).not.toHaveBeenCalled();
  });

  it('unowned -> NOT evaluated', async () => {
    await svc.ingestComments('p1');
    expect(evaluate()).not.toHaveBeenCalled();
  });

  it('lookup_failed -> NOT evaluated', async () => {
    mockResolveCampaignCompanyId.mockResolvedValue(CO_A);
    accountLookupError = { message: 'connection reset' };
    await svc.ingestComments('p1');
    expect(evaluate()).not.toHaveBeenCalled();
  });
});
