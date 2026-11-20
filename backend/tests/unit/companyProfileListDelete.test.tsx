/**
 * @jest-environment jsdom
 *
 * D2 (CI-397) CLIENT half, shipped with its server half (b3: the server alone would be dormant code).
 * A user can DELETE a profile list item: the save names the lists where the user removed something in
 * `replace_lists`, rebased on the list RE-READ at save time (a stale copy never drops another tab's
 * addition), and a server 409 BULK_LIST_REMOVAL_UNCONFIRMED gets a plain confirm naming the items.
 */
import { rebaseListEdit, planListReplacements, bulkRemovalConfirmText, saveProfileWithListEdits, REPLACEABLE_LISTS } from '../../../lib/companyProfile/listReplace';
import { REPLACEABLE_LISTS as SERVER_REPLACEABLE } from '../../../backend/services/companyProfile/savePayload';


const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('rebaseListEdit / planListReplacements (pure)', () => {
  it('a removal is rebased on the FRESH list: another tab\'s addition survives', () => {
    expect(rebaseListEdit(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'c', 'd'])).toEqual(['a', 'c', 'd']);
  });
  it('additions-only -> null (the union merge already handles it); case-insensitive matching', () => {
    expect(rebaseListEdit(['a'], ['a', 'b'], ['a'])).toBeNull();
    expect(rebaseListEdit(['Alpha', 'Beta'], ['alpha'], ['ALPHA', 'beta'])).toEqual(['ALPHA']);
  });
  it('a removal plus an addition: both applied on the fresh list', () => {
    expect(rebaseListEdit(['a', 'b'], ['a', 'x'], ['a', 'b', 'z'])).toEqual(['a', 'z', 'x']);
  });
  it('plans only replaceable lists with a removal; competitors are never replaced', () => {
    const plan = planListReplacements(
      { goals_list: ['g1', 'g2'], competitors_list: ['k1', 'k2'], industry_list: ['i1'] },
      { goals_list: ['g1'], competitors_list: ['k1'], industry_list: ['i1', 'i2'] },
      { goals_list: ['g1', 'g2'], competitors_list: ['k1', 'k2'], industry_list: ['i1'] },
    );
    expect(plan.replace_lists).toEqual(['goals_list']);
    expect(plan.lists).toEqual({ goals_list: ['g1'] });
  });
  it('the replaceable set is ONE definition (the server re-exports the client module)', () => {
    expect(SERVER_REPLACEABLE).toBe(REPLACEABLE_LISTS);
    expect(Object.keys(REPLACEABLE_LISTS)).not.toContain('competitors_list');
  });
  it('b3\'s plain confirm', () => {
    expect(bulkRemovalConfirmText([{ field: 'goals_list', removed: ['a', 'b'] }, { removed: ['c'] }])).toBe('This removes 3 items: a, b, c. Remove them?');
  });
});

describe('saveProfileWithListEdits (the save request the hook delegates to)', () => {
  const STORED = { company_id: 'c1', name: 'C', goals_list: ['grow', 'hire', 'launch'], industry_list: ['saas'] };
  let posts: Array<Record<string, unknown>>;
  let reReads: number;
  function fetchFor(opts: { fresh?: unknown; postReplies: unknown[] }) {
    posts = [];
    reReads = 0;
    return jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body ?? '{}'));
        return (opts.postReplies.shift() as any) ?? reply(200, { profile: STORED });
      }
      reReads += 1;
      if (opts.fresh instanceof Error) throw opts.fresh;
      return reply(200, { profile: opts.fresh ?? STORED });
    });
  }
  const save = (fetch: any, payload: Record<string, unknown>, confirm = jest.fn(() => true)) =>
    saveProfileWithListEdits({ fetch, companyId: 'c1', base: STORED, payload, confirm });

  it('deleting an item sends replace_lists rebased on the re-read list (another tab’s addition survives)', async () => {
    const f = fetchFor({ fresh: { ...STORED, goals_list: ['grow', 'hire', 'launch', 'from-other-tab'] }, postReplies: [] });
    const out = await save(f, { ...STORED, goals_list: ['grow', 'launch'] });
    expect(out.kind).toBe('saved');
    expect(posts).toHaveLength(1);
    expect(posts[0].replace_lists).toEqual(['goals_list']);
    expect(posts[0].goals_list).toEqual(['grow', 'launch', 'from-other-tab']);
  });

  it('additions only: a plain save (no replace_lists, no re-read)', async () => {
    const f = fetchFor({ postReplies: [] });
    await save(f, { ...STORED, goals_list: ['grow', 'hire', 'launch', 'new'] });
    expect(posts[0].replace_lists).toBeUndefined();
    expect(reReads).toBe(0);
  });

  it('409 BULK_LIST_REMOVAL_UNCONFIRMED -> confirm naming the items; yes resends with confirm_bulk_removal', async () => {
    const f = fetchFor({ postReplies: [reply(409, { code: 'BULK_LIST_REMOVAL_UNCONFIRMED', lists: [{ field: 'goals_list', stored: 3, removed: ['hire', 'launch'] }] })] });
    const confirm = jest.fn(() => true);
    const out = await save(f, { ...STORED, goals_list: ['grow'] }, confirm);
    expect(confirm).toHaveBeenCalledWith('This removes 2 items: hire, launch. Remove them?');
    expect(posts).toHaveLength(2);
    expect(posts[0].confirm_bulk_removal).toBeUndefined();
    expect(posts[1].confirm_bulk_removal).toBe(true);
    expect(out.kind).toBe('saved');
  });

  it('7c: an item added in another tab WHILE the confirm dialog is open survives the confirmed write', async () => {
    const reads = [
      { ...STORED, goals_list: ['grow', 'hire', 'launch'] }, // re-read before the first POST
      { ...STORED, goals_list: ['grow', 'hire', 'launch', 'added-during-dialog'] }, // re-read after the confirm
    ];
    posts = [];
    const f = jest.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body ?? '{}'));
        return posts.length === 1
          ? reply(409, { code: 'BULK_LIST_REMOVAL_UNCONFIRMED', lists: [{ removed: ['hire', 'launch'] }] })
          : reply(200, { profile: STORED });
      }
      return reply(200, { profile: reads.shift() });
    });
    const out = await save(f, { ...STORED, goals_list: ['grow'] });
    expect(out.kind).toBe('saved');
    expect(posts[1].confirm_bulk_removal).toBe(true);
    expect(posts[1].goals_list).toEqual(['grow', 'added-during-dialog']);
  });

  it('409 and the user says no -> cancelled, nothing more sent', async () => {
    const f = fetchFor({ postReplies: [reply(409, { code: 'BULK_LIST_REMOVAL_UNCONFIRMED', lists: [{ removed: ['hire', 'launch'] }] })] });
    const out = await save(f, { ...STORED, goals_list: ['grow'] }, jest.fn(() => false));
    expect(out.kind).toBe('cancelled');
    expect(posts).toHaveLength(1);
  });

  it('the re-read FAILS -> nothing is saved (a removal must never drop someone else’s addition)', async () => {
    const f = fetchFor({ fresh: new TypeError('Failed to fetch'), postReplies: [] });
    const out = await save(f, { ...STORED, goals_list: ['grow'] });
    expect(out.kind).toBe('reread_failed');
    expect(posts).toHaveLength(0);
  });

  it('wiring: the hook delegates its save to this function with the STORED profile as base', () => {
    const hook = require('fs').readFileSync(require('path').join(process.cwd(), 'hooks/useCompanyProfileState.tsx'), 'utf8') as string;
    expect(hook).toMatch(/saveProfileWithListEdits\(\{[\s\S]*?base: profile as Record<string, unknown> \| null,[\s\S]*?\}\)/);
  });
});
