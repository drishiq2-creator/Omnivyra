/**
 * enqueueRenderJob (dropped-error a9 DELTA decision row creator/rendering/renderQueue.ts:74). The route answers
 * 202 "queued" from this result, so a job with NO queue row must never come back as enqueued (nothing would claim it).
 *   - existence read fails (error object / thrown)       -> RenderEnqueueError RENDER_QUEUE_UNREADABLE, no insert
 *   - insert fails (error object / thrown / no row)       -> RenderEnqueueError RENDER_QUEUE_INSERT_FAILED
 *   - insert loses a race (23505) -> the winner's row is returned as render_enqueue_existing
 *   - CONTROL: readable + absent -> inserted, render_enqueued with a real id; readable + present -> existing
 */
import { enqueueRenderJob, isRenderEnqueueError } from '../../services/creator/rendering/renderQueue';

type R = { data: unknown; error: unknown } | 'throw';
function deps(reads: R[], insert: R) {
  const inserts: unknown[] = [];
  const read = () => {
    const r = reads.shift() ?? { data: null, error: null };
    return r === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(r);
  };
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: read }) }) }) };
  const ownedDbTable = () => ({
    insert: (row: unknown) => {
      inserts.push(row);
      return { select: () => ({ single: () => (insert === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(insert)) }) };
    },
  });
  return { d: { supabase, ownedDbTable, now: () => '2026-11-20T00:00:00Z' } as never, inserts };
}
const ARGS = { renderJobId: 'rj-1', providerKey: 'p1' };
const ERR = { data: null, error: { message: 'connection reset' } };

it.each([['an error object', ERR as R], ['a thrown rejection', 'throw' as R]])(
  'existence read UNREADABLE (%s) -> RENDER_QUEUE_UNREADABLE, nothing inserted', async (_n, read) => {
    const { d, inserts } = deps([read], { data: { id: 'q1' }, error: null });
    const err = await enqueueRenderJob(d, ARGS).then(() => null, (e) => e);
    expect(isRenderEnqueueError(err)).toBe(true);
    expect(err.code).toBe('RENDER_QUEUE_UNREADABLE');
    expect(inserts).toEqual([]);
  });

it.each([
  ['an error object', { data: null, error: { message: 'permission denied', code: '42501' } } as R],
  ['a thrown rejection', 'throw' as R],
  ['no row returned', { data: null, error: null } as R],
])('insert FAILED (%s) -> RENDER_QUEUE_INSERT_FAILED (never "enqueued" with a null id)', async (_n, ins) => {
  const { d } = deps([{ data: null, error: null }], ins);
  const err = await enqueueRenderJob(d, ARGS).then(() => null, (e) => e);
  expect(isRenderEnqueueError(err)).toBe(true);
  expect(err.code).toBe('RENDER_QUEUE_INSERT_FAILED');
});

it('insert loses a race (23505) -> the winning row is returned as existing', async () => {
  const { d } = deps([{ data: null, error: null }, { data: { id: 'q-winner' }, error: null }], { data: null, error: { message: 'duplicate', code: '23505' } });
  await expect(enqueueRenderJob(d, ARGS)).resolves.toEqual({ queue_job_id: 'q-winner', event: 'render_enqueue_existing' });
});

it('CONTROL: readable and ABSENT -> inserted, render_enqueued with a real id', async () => {
  const { d, inserts } = deps([{ data: null, error: null }], { data: { id: 'q1' }, error: null });
  await expect(enqueueRenderJob(d, ARGS)).resolves.toEqual({ queue_job_id: 'q1', event: 'render_enqueued' });
  expect(inserts).toHaveLength(1);
});

it('readable and PRESENT -> existing, nothing inserted', async () => {
  const { d, inserts } = deps([{ data: { id: 'q0' }, error: null }], { data: { id: 'q1' }, error: null });
  await expect(enqueueRenderJob(d, ARGS)).resolves.toEqual({ queue_job_id: 'q0', event: 'render_enqueue_existing' });
  expect(inserts).toEqual([]);
});

it('the route maps a RenderEnqueueError to 503 not_queued + Retry-After (never 202 queued)', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../../pages/api/activity-workspace/[id]/render-image.ts'), 'utf8');
  const block = src.slice(src.indexOf('if (isRenderEnqueueError(e))'), src.indexOf('if (isRenderEnqueueError(e))') + 400);
  expect(block).toContain("res.setHeader('Retry-After', '5')");
  expect(block).toContain('res.status(503)');
  expect(block).toContain("status: 'not_queued'");
  // the 202 is reachable only after enqueueRenderJob resolved, which now always carries a real queue_job_id
  expect(src.indexOf('const enq = await enqueueRenderJob(')).toBeLessThan(src.indexOf('return res.status(202)'));
});
