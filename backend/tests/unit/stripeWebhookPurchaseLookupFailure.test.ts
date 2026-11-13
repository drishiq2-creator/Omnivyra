/**
 * Reads contract (e9 BLOCKING): the Stripe webhook's purchase lookup FAILING is not "no purchase".
 * Before: `{ data }` only -> a failed read returned null -> the event took the no-purchase path and was marked
 * processed -> Stripe stopped redelivering and a paid purchase was never fulfilled. Now the lookup throws, the route
 * answers 500 BEFORE the event is recorded, and Stripe's retry starts clean.
 * Real route + real signature verification; only the DB and the purchase service are faked.
 */
import crypto from 'crypto';

const SECRET = 'whsec_sim_only_not_real';
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const state: { lookupFails: boolean; recorded: string[]; completed: string[] } = { lookupFails: false, recorded: [], completed: [] };
const PURCHASE = { id: 'cp-1', organization_id: 'org-1', status: 'pending', fulfillment_status: 'pending' };

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const b: any = {};
    b.select = () => b; b.eq = () => b; b.or = () => b; b.update = () => b; b.insert = () => b;
    b.maybeSingle = async () => {
      if (table === 'credit_purchases' && state.lookupFails) return { data: null, error: { message: 'connection reset' } };
      if (table === 'credit_purchases') return { data: PURCHASE, error: null };
      return { data: null, error: null };
    };
    b.then = (res: any) => Promise.resolve({ data: null, error: null }).then(res);
    return b;
  },
}));
jest.mock('../../services/purchaseService', () => ({
  recordPaymentProviderEvent: async (i: { providerEventId: string }) => { state.recorded.push(i.providerEventId); return { id: `row-${i.providerEventId}`, duplicate: false, processingStatus: 'received' }; },
  completePurchase: async (id: string) => { state.completed.push(id); return { success: true, purchaseId: id, creditsGranted: 100 }; },
  failPurchase: async () => undefined,
}));
jest.mock('../../services/billingSubscriptionService', () => ({ applyStripeSubscriptionEvent: async () => undefined }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../../../pages/api/stripe/webhook').default;

function deliver(evt: unknown) {
  const raw = JSON.stringify(evt);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`;
  const req: any = {
    method: 'POST', headers: { 'stripe-signature': sig }, query: {},
    on(ev: string, cb: (c?: unknown) => void) { if (ev === 'data') cb(Buffer.from(raw)); if (ev === 'end') cb(); return req; },
  };
  const out: any = { status: 0, body: null };
  const res: any = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; }, setHeader() { return res; }, end() { return res; } };
  return Promise.resolve(handler(req, res)).then(() => out);
}
const paid = { id: 'evt_1', type: 'payment_intent.succeeded', created: 1779000000, data: { object: { id: 'pi_1', amount: 1000, currency: 'usd' } } };

beforeEach(() => { state.lookupFails = false; state.recorded = []; state.completed = []; });

it('a FAILED purchase lookup -> 500 (Stripe retries); NO event recorded, nothing completed', async () => {
  state.lookupFails = true;
  const r = await deliver(paid);
  expect(r.status).toBe(500);
  expect(String(r.body?.message)).toContain('stripe purchase lookup failed');
  expect(state.recorded).toEqual([]);   // the retry starts clean - not a "duplicate" of a processed event
  expect(state.completed).toEqual([]);
});

it('CONTROL: the same event with a working lookup completes the purchase (200)', async () => {
  const r = await deliver(paid);
  expect(r.status).toBe(200);
  expect(state.recorded).toEqual(['evt_1']);
  expect(state.completed).toEqual(['cp-1']);
});
