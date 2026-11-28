/**
 * Tenant isolation for platformTokenService.getToken (org, platform) -> token.
 *
 * Two tenants (company A, company B) share a member. The fixture holds every
 * row shape the old selector could wrongly pick:
 *   - a company_id NULL (legacy/personal) row owned by a member of A and B,
 *     updated MORE recently than A's own row;
 *   - company B's own row, owned by the shared member;
 *   - another member's personal (NULL) row on a platform A never connected;
 *   - two active company-A rows on one platform (ambiguity);
 *   - an injected database error on each read.
 *
 * The fake PostgREST builder MODELS every filter the selector uses (eq, in,
 * or with eq/is.null, order, limit) and throws on anything unmodelled, so a
 * passing assertion cannot come from a filter being silently ignored.
 */

type Row = Record<string, any>;

const store: { user_company_roles: Row[]; social_accounts: Row[] } = {
  user_company_roles: [],
  social_accounts: [],
};
const injectedErrors: Record<string, { message: string } | undefined> = {};

function matchOrClause(row: Row, clause: string): boolean {
  return clause.split(',').some((part) => {
    const [col, op, ...rest] = part.split('.');
    const val = rest.join('.');
    if (op === 'eq') return row[col] === val;
    if (op === 'is' && val === 'null') return row[col] === null || row[col] === undefined;
    throw new Error(`fake builder: unmodelled or() operator ${op}`);
  });
}

function buildQuery(table: keyof typeof store) {
  const preds: Array<(r: Row) => boolean> = [];
  let orderBy: { col: string; asc: boolean } | null = null;
  let limitN: number | null = null;
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => { preds.push((r) => r[col] === val); return q; },
    in: (col: string, vals: unknown[]) => { preds.push((r) => vals.includes(r[col])); return q; },
    is: (col: string, val: unknown) => {
      if (val !== null) throw new Error('fake builder: is() only models null');
      preds.push((r) => r[col] === null || r[col] === undefined);
      return q;
    },
    or: (clause: string) => { preds.push((r) => matchOrClause(r, clause)); return q; },
    // SQL semantics: NOT (col IS NULL); NOT (col LIKE p) is NULL -> excluded when col is NULL.
    not: (col: string, op: string, val: unknown) => {
      if (op === 'is' && val === null) { preds.push((r) => r[col] !== null && r[col] !== undefined); return q; }
      if (op === 'like' && typeof val === 'string') {
        const re = new RegExp('^' + val.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        preds.push((r) => r[col] !== null && r[col] !== undefined && !re.test(String(r[col])));
        return q;
      }
      throw new Error(`fake builder: unmodelled not() ${op}`);
    },
    order: (col: string, opts?: { ascending?: boolean }) => { orderBy = { col, asc: opts?.ascending !== false }; return q; },
    limit: (n: number) => { limitN = n; return q; },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      try {
        const err = injectedErrors[table];
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        let rows = store[table].filter((r) => preds.every((p) => p(r)));
        if (orderBy) {
          const { col, asc } = orderBy;
          rows = [...rows].sort((a, b) => (asc ? 1 : -1) * String(a[col]).localeCompare(String(b[col])));
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      } catch (e) {
        return Promise.reject(e).then(resolve, reject);
      }
    },
  };
  return new Proxy(q, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      throw new Error(`fake builder: unmodelled method ${String(prop)} on ${table}`);
    },
  });
}

jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => buildQuery(table as keyof typeof store),
}));
jest.mock('../../auth/tokenStore', () => ({
  getToken: jest.fn(async (socialAccountId: string) => ({ access_token: `tok:${socialAccountId}` })),
  isTokenExpiringSoon: jest.fn(() => false),
}));
jest.mock('../../auth/tokenRefresh', () => ({ refreshPlatformToken: jest.fn(async () => null) }));

import {
  getToken,
  getPlatformsWithTokensForOrg,
  getPlatformsWithActiveSocialAccountsForOrg,
} from '../../services/platformTokenService';

const A = 'company-a';
const B = 'company-b';
const C = 'company-c';

function seed() {
  store.user_company_roles = [
    { user_id: 'user-a1', company_id: A, status: 'active' },
    { user_id: 'user-a2', company_id: A, status: 'active' },
    { user_id: 'user-ab', company_id: A, status: 'active' },
    { user_id: 'user-ab', company_id: B, status: 'active' },
    { user_id: 'user-b1', company_id: B, status: 'active' },
    { user_id: 'user-c1', company_id: C, status: 'active' },
    { user_id: 'user-c2', company_id: C, status: 'active' },
  ];
  store.social_accounts = [
    // A's own single linkedin account (positive control), oldest.
    { id: 'sa-a-linkedin', user_id: 'user-a1', company_id: A, platform: 'linkedin', platform_user_id: 'puid-sa-a-linkedin', is_active: true, access_token: 'enc', updated_at: '2026-01-01T00:00:00Z' },
    // B's own linkedin account, connected by the member shared with A.
    { id: 'sa-b-linkedin', user_id: 'user-ab', company_id: B, platform: 'linkedin', platform_user_id: 'puid-sa-b-linkedin', is_active: true, access_token: 'enc', updated_at: '2026-02-01T00:00:00Z' },
    // Legacy NULL-company row of the shared member, the MOST recent linkedin row.
    { id: 'sa-null-linkedin', user_id: 'user-ab', company_id: null, platform: 'linkedin', platform_user_id: 'puid-sa-null-linkedin', is_active: true, access_token: 'enc', updated_at: '2026-06-01T00:00:00Z' },
    // Another member's personal row on a platform A never connected as a company.
    { id: 'sa-null-x-a2', user_id: 'user-a2', company_id: null, platform: 'twitter', platform_user_id: 'puid-sa-null-x-a2', is_active: true, access_token: 'enc', updated_at: '2026-03-01T00:00:00Z' },
    // Two active company-A rows on one platform.
    { id: 'sa-a-fb-1', user_id: 'user-a1', company_id: A, platform: 'facebook', platform_user_id: 'puid-sa-a-fb-1', is_active: true, access_token: 'enc', updated_at: '2026-04-01T00:00:00Z' },
    { id: 'sa-a-fb-2', user_id: 'user-a2', company_id: A, platform: 'facebook', platform_user_id: 'puid-sa-a-fb-2', is_active: true, access_token: 'enc', updated_at: '2026-05-01T00:00:00Z' },
    // B's youtube account only.
    { id: 'sa-b-youtube', user_id: 'user-b1', company_id: B, platform: 'youtube', platform_user_id: 'puid-sa-b-youtube', is_active: true, access_token: 'enc', updated_at: '2026-01-15T00:00:00Z' },
    // Shared member's NULL-company instagram row: neither A nor B connected instagram as a company.
    { id: 'sa-null-ig-ab', user_id: 'user-ab', company_id: null, platform: 'instagram', platform_user_id: 'puid-sa-null-ig-ab', is_active: true, access_token: 'enc', updated_at: '2026-03-01T00:00:00Z' },

    // ---- company C: rows that must NOT count as a second account ----
    // linkedin: one API row + one token-less extension/cookie-backed row (newer).
    { id: 'sa-c-li-api', user_id: 'user-c1', company_id: C, platform: 'linkedin', platform_user_id: 'li-c-1', is_active: true, access_token: 'enc', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'sa-c-li-ext', user_id: 'user-c2', company_id: C, platform: 'linkedin', platform_user_id: 'li-c-2', is_active: true, access_token: null, updated_at: '2026-06-01T00:00:00Z' },
    // facebook: one real row + one planning_% placeholder (newer, even carrying a value).
    { id: 'sa-c-fb', user_id: 'user-c1', company_id: C, platform: 'facebook', platform_user_id: 'fb-c-1', is_active: true, access_token: 'enc', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'sa-c-fb-plan', user_id: 'user-c2', company_id: C, platform: 'facebook', platform_user_id: 'planning_facebook_c', is_active: true, access_token: 'enc', updated_at: '2026-06-01T00:00:00Z' },
    // x: ONE account stored under both aliases (same platform_user_id).
    { id: 'sa-c-x-old', user_id: 'user-c1', company_id: C, platform: 'twitter', platform_user_id: 'x-c-1', is_active: true, access_token: 'enc', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'sa-c-x-new', user_id: 'user-c1', company_id: C, platform: 'x', platform_user_id: 'x-c-1', is_active: true, access_token: 'enc', updated_at: '2026-05-01T00:00:00Z' },
    // youtube: two DISTINCT token-bearing accounts (genuine ambiguity, control).
    { id: 'sa-c-yt-1', user_id: 'user-c1', company_id: C, platform: 'youtube', platform_user_id: 'yt-c-1', is_active: true, access_token: 'enc', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'sa-c-yt-2', user_id: 'user-c2', company_id: C, platform: 'youtube', platform_user_id: 'yt-c-2', is_active: true, access_token: 'enc', updated_at: '2026-02-01T00:00:00Z' },
  ];
  for (const k of Object.keys(injectedErrors)) delete injectedErrors[k];
}

beforeEach(seed);

describe('platformTokenService.getToken — two-tenant isolation', () => {
  it('fixture: the wrong rows exist and would win by recency', () => {
    const linkedinForA = store.social_accounts
      .filter((r) => r.platform === 'linkedin' && r.is_active)
      .filter((r) => store.user_company_roles.some((m) => m.user_id === r.user_id && m.company_id === A));
    // The NULL row and B's row both belong to a member of A, and the NULL row is newest.
    expect(linkedinForA.map((r) => r.id).sort()).toEqual(['sa-a-linkedin', 'sa-b-linkedin', 'sa-null-linkedin']);
    const newest = [...linkedinForA].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    expect(newest.id).toBe('sa-null-linkedin');
    expect(store.social_accounts.filter((r) => r.company_id === A && r.platform === 'facebook')).toHaveLength(2);
  });

  it('positive control: A receives its own single account', async () => {
    const tok = await getToken(A, A, 'linkedin');
    expect(tok?.access_token).toBe('tok:sa-a-linkedin');
  });

  it('positive control: B receives its own single account', async () => {
    const tok = await getToken(B, B, 'youtube');
    expect(tok?.access_token).toBe('tok:sa-b-youtube');
  });

  it('B never receives the shared member\'s NULL-company row', async () => {
    const tok = await getToken(B, B, 'linkedin');
    expect(tok?.access_token).toBe('tok:sa-b-linkedin');
  });

  it('A never receives B\'s row or the NULL-company row', async () => {
    const tok = await getToken(A, A, 'linkedin');
    expect(tok?.access_token).not.toBe('tok:sa-null-linkedin');
    expect(tok?.access_token).not.toBe('tok:sa-b-linkedin');
  });

  it('another member\'s personal (NULL-company) account is not A\'s connection', async () => {
    expect(store.social_accounts.some((r) => r.id === 'sa-null-x-a2')).toBe(true);
    await expect(getToken(A, A, 'x')).resolves.toBeNull();
  });

  it('A cannot reach B\'s account on a platform only B connected', async () => {
    await expect(getToken(A, A, 'youtube')).resolves.toBeNull();
  });

  it('two active company accounts on one platform are refused as ambiguous, not picked by recency', async () => {
    await expect(getToken(A, A, 'facebook')).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_AMBIGUOUS' });
  });

  it('a membership read error is a distinct error, never "not connected"', async () => {
    injectedErrors.user_company_roles = { message: 'connection reset' };
    await expect(getToken(A, A, 'linkedin')).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_LOOKUP_FAILED' });
  });

  it('a social_accounts read error is a distinct error, never "not connected"', async () => {
    injectedErrors.social_accounts = { message: 'statement timeout' };
    await expect(getToken(A, A, 'linkedin')).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_LOOKUP_FAILED' });
  });

  it('control: with no injected error the same call resolves (the error test is not passing on fixture absence)', async () => {
    await expect(getToken(A, A, 'linkedin')).resolves.toMatchObject({ access_token: 'tok:sa-a-linkedin' });
  });
});

describe('platformTokenService.getToken — what counts as a second account', () => {
  it('fixture: company C has 2 active rows on each of linkedin, facebook, x(+twitter), youtube', () => {
    for (const plats of [['linkedin'], ['facebook'], ['x', 'twitter'], ['youtube']]) {
      expect(store.social_accounts.filter((r) => r.company_id === C && r.is_active && plats.includes(r.platform))).toHaveLength(2);
    }
  });

  it('a token-less extension/cookie row does not make the API account ambiguous', async () => {
    await expect(getToken(C, C, 'linkedin')).resolves.toMatchObject({ access_token: 'tok:sa-c-li-api' });
  });

  it('a planning_% placeholder does not make the real account ambiguous', async () => {
    await expect(getToken(C, C, 'facebook')).resolves.toMatchObject({ access_token: 'tok:sa-c-fb' });
  });

  it('one account stored under both x and twitter is one account (latest row used)', async () => {
    await expect(getToken(C, C, 'x')).resolves.toMatchObject({ access_token: 'tok:sa-c-x-new' });
    await expect(getToken(C, C, 'twitter')).resolves.toMatchObject({ access_token: 'tok:sa-c-x-new' });
  });

  it('control: two distinct token-bearing accounts are still refused as ambiguous', async () => {
    await expect(getToken(C, C, 'youtube')).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_AMBIGUOUS' });
    await expect(getToken(A, A, 'facebook')).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_AMBIGUOUS' });
  });
});

describe('platform list readers — company-only, read error distinct from none', () => {
  const listers = [
    ['getPlatformsWithTokensForOrg', getPlatformsWithTokensForOrg],
    ['getPlatformsWithActiveSocialAccountsForOrg', getPlatformsWithActiveSocialAccountsForOrg],
  ] as const;

  for (const [name, list] of listers) {
    it(`${name}: positive control - each tenant lists its own company platforms`, async () => {
      expect(await list(A)).toEqual(expect.arrayContaining(['facebook', 'linkedin']));
      expect(await list(B)).toEqual(expect.arrayContaining(['linkedin', 'youtube']));
    });

    it(`${name}: a NULL-company row of a member is listed for neither tenant`, async () => {
      expect(store.social_accounts.some((r) => r.id === 'sa-null-ig-ab' && r.company_id === null)).toBe(true);
      expect(await list(A)).not.toContain('instagram');
      expect(await list(B)).not.toContain('instagram');
      // another member's personal twitter row is not A's platform
      expect(await list(A)).not.toContain('x');
    });

    it(`${name}: A never lists B-only platforms`, async () => {
      expect(await list(A)).not.toContain('youtube');
    });

    it(`${name}: a membership read error rejects with LOOKUP_FAILED, never []`, async () => {
      injectedErrors.user_company_roles = { message: 'connection reset' };
      await expect(list(A)).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_LOOKUP_FAILED' });
    });

    it(`${name}: a social_accounts read error rejects with LOOKUP_FAILED, never []`, async () => {
      injectedErrors.social_accounts = { message: 'statement timeout' };
      await expect(list(A)).rejects.toMatchObject({ code: 'PLATFORM_ACCOUNT_LOOKUP_FAILED' });
    });
  }
});
