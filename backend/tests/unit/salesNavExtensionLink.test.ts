/**
 * The Sales Navigator page signs in the Sales Navigator EXTENSION only (owner 2026-11-22, two LinkedIn extensions):
 * every message it posts names product 'salesnav', the claim code is requested for 'salesnav', and the states are
 * never collapsed ("not detected" is not "signed out").
 */
import { connectSalesNavExtension, readSalesNavExtensionState } from '../../../lib/prospects/salesnav/salesNavExtensionLink';

/** A page window: posts are recorded; `answer` decides what an extension sends back (same window source). */
function fakeWindow(answer: (msg: any) => any | null) {
  const target = new EventTarget();
  const posted: any[] = [];
  const win: any = {
    location: { origin: 'https://www.omnivyra.com' },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    postMessage(msg: any) {
      posted.push(msg);
      const reply = answer(msg);
      if (reply) setTimeout(() => target.dispatchEvent(Object.assign(new Event('message'), { data: reply, source: win })), 5);
    },
  };
  return { win, posted };
}
const ORG = '11111111-1111-4111-8111-111111111111';

describe('Sales Navigator page: extension sign-in state', () => {
  it('asks ONLY the Sales Navigator extension (product on the message)', async () => {
    const { win, posted } = fakeWindow(() => ({ type: 'OMNIVYRA_EXTENSION_AUTH_STATE', data: { isAuthenticated: true, orgId: ORG } }));
    expect(await readSalesNavExtensionState(ORG, win, 200)).toEqual({ kind: 'signed_in', orgId: ORG });
    expect(posted).toEqual([{ type: 'OMNIVYRA_REQUEST_AUTH_STATE', product: 'salesnav' }]);
  });

  it('no answer is "not_detected", never "signed_out"', async () => {
    const { win } = fakeWindow(() => null);
    expect(await readSalesNavExtensionState(ORG, win, 50)).toEqual({ kind: 'not_detected' });
  });

  it('CONTROL: an installed, signed-out extension is "signed_out"; another company is "other_company"', async () => {
    expect(await readSalesNavExtensionState(ORG, fakeWindow(() => ({ type: 'OMNIVYRA_EXTENSION_AUTH_STATE', data: { isAuthenticated: false } })).win, 200))
      .toEqual({ kind: 'signed_out' });
    expect(await readSalesNavExtensionState(ORG, fakeWindow(() => ({ type: 'OMNIVYRA_EXTENSION_AUTH_STATE', data: { isAuthenticated: true, orgId: 'other' } })).win, 200))
      .toEqual({ kind: 'other_company', orgId: 'other' });
  });
});

describe('Sales Navigator page: connecting the extension', () => {
  const okFetch = (async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { claim_code: 'cc_x' } }) })) as unknown as typeof fetch;

  it('requests a claim code FOR salesnav and hands it to the salesnav extension only', async () => {
    const calls: any[] = [];
    const fetcher = (async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return (okFetch as any)(); }) as unknown as typeof fetch;
    const { win, posted } = fakeWindow((m) => (m.type === 'OMNIVYRA_CLAIM_CODE' ? { type: 'OMNIVYRA_CLAIM_CODE_RESULT', data: { success: true } } : null));
    await connectSalesNavExtension(ORG, win, fetcher, 200);
    expect(calls).toEqual([{ url: '/api/extension/bootstrap', body: { organization_id: ORG, product: 'salesnav' } }]);
    expect(posted).toEqual([{ type: 'OMNIVYRA_CLAIM_CODE', product: 'salesnav', data: { claim_code: 'cc_x' } }]);
  });

  it('a silent extension, a refused redeem and an unavailable store each fail with their own message', async () => {
    await expect(connectSalesNavExtension(ORG, fakeWindow(() => null).win, okFetch, 50)).rejects.toThrow(/did not answer/);
    await expect(connectSalesNavExtension(ORG, fakeWindow(() => ({ type: 'OMNIVYRA_CLAIM_CODE_RESULT', data: { success: false, message: 'REDEEM_FAILED' } })).win, okFetch, 200))
      .rejects.toThrow(/could not sign in \(REDEEM_FAILED\)/);
    const down = (async () => ({ ok: false, status: 503, json: async () => ({ success: false, error: 'CLAIM_STORE_UNAVAILABLE' }) })) as unknown as typeof fetch;
    await expect(connectSalesNavExtension(ORG, fakeWindow(() => null).win, down, 50)).rejects.toThrow(/temporarily unavailable/);
  });
});
