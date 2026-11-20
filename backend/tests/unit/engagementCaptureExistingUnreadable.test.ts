/**
 * captureEngagementSignals (dropped-error a9 decision row engagementCaptureService.ts:31): the "which posts already
 * have signals" read decides what gets inserted. A FAILED read must not read as "none have signals" - that re-inserted
 * placeholder rows for every post. Error object AND thrown rejection -> the job rejects and inserts NOTHING; a
 * READABLE empty answer (the genuinely-empty control) still inserts the placeholders.
 */
type R = { data?: unknown; error?: { message: string; code?: string } | null } | 'throw';
const script: Record<string, R[]> = {};
const inserts: unknown[][] = [];
function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'in']) b[m] = () => b;
  b.insert = (rows: unknown[]) => { inserts.push(rows); return Promise.resolve({ error: null }); };
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    const r = (script[table] ?? []).shift() ?? { data: [], error: null };
    return (r === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve({ data: r.data ?? null, error: r.error ?? null })).then(res, rej);
  };
  return b;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => builder(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => builder(t) } }));

import { captureEngagementSignals } from '../../services/engagementCaptureService';

const POSTS = { data: [{ id: 'p1', platform: 'LinkedIn' }, { id: 'p2', platform: null }], error: null };
beforeEach(() => { for (const k of Object.keys(script)) delete script[k]; inserts.length = 0; });

it.each([
  ['an error object', { data: null, error: { message: 'connection reset' } } as R],
  ['a thrown rejection', 'throw' as R],
])('existing-signals read UNREADABLE (%s) -> rejects, inserts nothing', async (_n, outcome) => {
  script.community_posts = [POSTS];
  script.engagement_signals = [outcome];
  await expect(captureEngagementSignals()).rejects.toThrow(/engagement_signals|socket hang up/);
  expect(inserts).toEqual([]);
});

it('CONTROL: readable and EMPTY -> placeholders for every post (5 types x 2 posts)', async () => {
  script.community_posts = [POSTS];
  script.engagement_signals = [{ data: [], error: null }];
  await expect(captureEngagementSignals()).resolves.toMatchObject({ signals_created: 10 });
  expect(inserts).toHaveLength(1);
  expect((inserts[0] as Array<{ post_id: string }>).map((r) => r.post_id).sort()).toEqual(['p1', 'p1', 'p1', 'p1', 'p1', 'p2', 'p2', 'p2', 'p2', 'p2']);
});

it('a post that already has signals is skipped (the read is what decides)', async () => {
  script.community_posts = [POSTS];
  script.engagement_signals = [{ data: [{ post_id: 'p1' }], error: null }];
  await expect(captureEngagementSignals()).resolves.toMatchObject({ signals_created: 5 });
  expect((inserts[0] as Array<{ post_id: string }>).every((r) => r.post_id === 'p2')).toBe(true);
});
