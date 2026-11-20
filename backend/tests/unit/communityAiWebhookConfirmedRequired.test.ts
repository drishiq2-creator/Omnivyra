/**
 * Customer webhook 'executed' always carries a boolean metadata.confirmed (b3 ruling 2026-11-20, PL-122 finding 1).
 *   - the executor sends confirmed:true for a confirmed send and confirmed:false for a manual simulation
 *     (status 'sent_unverified'), both as event 'executed' (compatibility: no new event type);
 *   - the delivery layer never sends an 'executed' payload without a boolean confirmed: absent / non-boolean -> false;
 *   - CONTROL: a payload that already has a boolean is delivered unchanged, and other event types are untouched.
 */
const posted: Array<{ url: string; body: any }> = [];
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: async (url: string, init: { body: string }) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; },
}));
function hooksBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ webhook_url: 'https://hook.example/x' }], error: null }).then(res);
  return b;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => hooksBuilder() } }));

import { sendCommunityAiWebhooks, deliveredWebhookPayload } from '../../services/communityAiWebhookService';

const base = { tenant_id: 't-1', organization_id: 'o-1', action_id: 'a-1', message: 'm' };
let err: jest.SpyInstance;
beforeEach(() => { posted.length = 0; err = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => err.mockRestore());

describe('delivery: confirmed is never absent on executed', () => {
  it.each([
    ['absent', { platform: 'x' }],
    ['a string', { confirmed: 'true' }],
    ['null metadata', null],
  ])('executed with confirmed %s is delivered as confirmed:false and logged', async (_n, metadata) => {
    await sendCommunityAiWebhooks({ ...base, event_type: 'executed', metadata: metadata as any });
    expect(posted).toHaveLength(1);
    expect(posted[0].body.metadata.confirmed).toBe(false);
    expect(err).toHaveBeenCalledWith('COMMUNITY_AI_WEBHOOK_CONFIRMED_MISSING', expect.any(String));
  });

  it.each([true, false])('CONTROL: confirmed %s is delivered unchanged, nothing logged', async (confirmed) => {
    await sendCommunityAiWebhooks({ ...base, event_type: 'executed', metadata: { confirmed, platform: 'x' } });
    expect(posted[0].body.metadata).toEqual({ confirmed, platform: 'x' });
    expect(err).not.toHaveBeenCalled();
  });

  it('CONTROL: a failed event is untouched (confirmed belongs to executed only)', () => {
    const p = { ...base, event_type: 'failed' as const, metadata: { platform: 'x' } };
    expect(deliveredWebhookPayload(p)).toBe(p);
  });
});
