/**
 * Launch gate (b3, 11-18): WhatsApp stays unavailable until the stranded WhatsApp line (stage 3) is live.
 * C114 showed WhatsApp has never been used in production, and main's WhatsApp code lacks that line's
 * correct-sending fixes (STOP opt-out, send claim, unconfirmed sends, quota).
 *
 * Pinned here, against the REAL routes and the REAL service functions:
 *   - the flag is DEFAULT OFF and STRICT (only the exact string 'true' enables it);
 *   - OFF: every gated route answers 409 WHATSAPP_NOT_AVAILABLE (retryable:false) FIRST, for every caller,
 *     before any auth lookup, DB read or service call; the service send seams throw before any read
 *     or provider call;
 *   - ON: the same requests proceed past the gate (a positive leg for every refusal);
 *   - GET routes are unaffected; GET /api/whatsapp/status reports the flag to any signed-in user.
 * The Meta OAuth callback's WhatsApp token save is pinned in whatsappConnectGateMetaCallback.test.ts.
 */
export {};

type Row = Record<string, any>;
const calls: string[] = [];
const fetchCalls: string[] = [];

/** Records every table touched; answers empty. A gated request must leave this EMPTY. */
function recorder(t: string) {
  calls.push(`db:${t}`);
  const api: Record<string, any> = {};
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'is', 'in', 'gt', 'lt', 'order', 'range', 'limit']) {
    api[m] = () => api;
  }
  api.single = async () => ({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
  api.maybeSingle = async () => ({ data: null, error: null });
  api.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(res);
  return api;
}

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => recorder(t) }));
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: (t: string) => recorder(t), rpc: async () => ({ data: null, error: null }) },
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: async ({ res }: { res: any }) => {
    calls.push('auth:enforceCompanyAccess');
    // Deny after recording: the positive leg only needs to prove the gate let the request through.
    res.status(403).json({ error: 'stop here' });
    return null;
  },
}));
jest.mock('../../services/rbacService', () => ({
  enforceRole: async () => { calls.push('auth:enforceRole'); return true; },
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
}));
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: async (req: any) =>
    (req.headers?.authorization ? { user: { id: 'u1' }, error: null } : { user: null, error: 'no session' }),
}));
jest.mock('../../auth/metaAuthService', () => ({ getValidAccessToken: async () => { calls.push('meta:token'); return 't'; } }));
jest.mock('../../auth/credentialEncryption', () => ({ requireEncryptionKey: () => Buffer.from('11'.repeat(32), 'hex') }));
jest.mock('../../middleware/queueBackpressure', () => ({ enqueueOrThrow: async () => { calls.push('queue:enqueue'); } }));
jest.mock('../../queue/contentGenerationQueues', () => ({ getContentQueue: () => ({}) }));
jest.mock('../../services/whatsappTemplateService', () => ({
  getActiveTemplate: async () => ({ name: 'tpl' }),
  submitTemplate: async () => { calls.push('meta:submitTemplate'); return 'tpl-1'; },
}));
jest.mock('../../services/whatsappRateLimiter', () => ({
  checkAndConsume: async () => ({ allowed: true, tier: 1, remaining: 1 }),
  getBroadcastChunkStrategy: () => ({ batch_size: 10, delay_ms: 0 }),
}));

import createRoute from '../../../pages/api/whatsapp/broadcasts/index';
import idRoute from '../../../pages/api/whatsapp/broadcasts/[id]';
import templatesRoute from '../../../pages/api/whatsapp/templates/index';
import statusRoute from '../../../pages/api/whatsapp/status';
import { enqueueBroadcast, retryFailed, processBatch } from '../../services/whatsappBroadcastService';
import {
  isWhatsAppEnabled, WhatsAppNotAvailableError, WHATSAPP_NOT_AVAILABLE,
} from '../../services/whatsappAvailability';

const PRIOR = process.env.WHATSAPP_CONNECT_ENABLED;
const setFlag = (v: string | undefined) => {
  if (v === undefined) delete process.env.WHATSAPP_CONNECT_ENABLED;
  else process.env.WHATSAPP_CONNECT_ENABLED = v;
};
afterAll(() => setFlag(PRIOR));

function mockRes() {
  const res: any = { statusCode: 0, body: undefined, headers: {} as Row };
  res.setHeader = (k: string, v: unknown) => { res.headers[k] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: unknown) => { res.body = p; return res; };
  return res;
}
async function call(handler: unknown, req: Row) {
  const res = mockRes();
  await (handler as (q: unknown, s: unknown) => Promise<void>)({ headers: {}, query: {}, body: {}, ...req }, res);
  return res;
}

const REFUSAL = { error: 'WhatsApp is not available yet.', code: WHATSAPP_NOT_AVAILABLE, retryable: false };
const CALLERS: Array<[string, Row]> = [
  ['an unauthenticated caller', {}],
  ['a signed-in company admin', { authorization: 'Bearer admin' }],
];
const GATED: Array<[string, unknown, Row]> = [
  ['POST /api/whatsapp/broadcasts (create)', createRoute,
    { method: 'POST', body: { company_id: 'c1', social_account_id: 'sa1', name: 'n', message_type: 'text', body: 'hi', enqueue: true } }],
  ['POST /api/whatsapp/broadcasts/[id]?action=enqueue', idRoute, { method: 'POST', query: { id: 'b1', action: 'enqueue' } }],
  ['POST /api/whatsapp/broadcasts/[id]?action=retry', idRoute, { method: 'POST', query: { id: 'b1', action: 'retry' } }],
  ['POST /api/whatsapp/broadcasts/[id]?action=recipients', idRoute,
    { method: 'POST', query: { id: 'b1', action: 'recipients' }, body: { contacts: [{ phone_e164: '+15550100001' }] } }],
  ['POST /api/whatsapp/templates (Meta submit)', templatesRoute,
    { method: 'POST', body: { company_id: 'c1', social_account_id: 'sa1', template_name: 't', template_category: 'MARKETING', components: [] } }],
];

beforeEach(() => {
  calls.length = 0;
  fetchCalls.length = 0;
  (global as any).fetch = async (url: string) => { fetchCalls.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; };
});

describe('the flag is DEFAULT OFF and STRICT', () => {
  it.each([[undefined], [''], ['1'], ['TRUE'], ['True'], [' true'], ['true '], ['yes'], ['false']])(
    'WHATSAPP_CONNECT_ENABLED=%j -> disabled', (v) => { setFlag(v as string | undefined); expect(isWhatsAppEnabled()).toBe(false); });

  it("only the exact string 'true' enables it", () => { setFlag('true'); expect(isWhatsAppEnabled()).toBe(true); });
});

describe('OFF: every gated route refuses FIRST, for every caller', () => {
  beforeEach(() => setFlag(undefined));

  for (const [label, route, req] of GATED) {
    for (const [who, headers] of CALLERS) {
      it(`${label}, ${who}: 409 WHATSAPP_NOT_AVAILABLE, nothing read, written or called`, async () => {
        const res = await call(route, { ...req, headers });
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual(REFUSAL);
        expect(calls).toEqual([]);
        expect(fetchCalls).toEqual([]);
      });
    }
  }
});

describe('ON: the same requests proceed past the gate (positive leg for each refusal)', () => {
  beforeEach(() => setFlag('true'));

  for (const [label, route, req] of GATED) {
    it(`${label}: not refused by the gate; reaches its own auth`, async () => {
      const res = await call(route, { ...req, headers: { authorization: 'Bearer admin' } });
      expect(res.body?.code).not.toBe(WHATSAPP_NOT_AVAILABLE);
      expect(calls.length).toBeGreaterThan(0);
    });
  }
});

describe('OFF: read-only routes are unaffected', () => {
  beforeEach(() => setFlag(undefined));

  it('GET /api/whatsapp/broadcasts still reaches its auth', async () => {
    const res = await call(createRoute, { method: 'GET', query: { company_id: 'c1' } });
    expect(res.body?.code).not.toBe(WHATSAPP_NOT_AVAILABLE);
    expect(calls).toContain('auth:enforceCompanyAccess');
  });

  it('GET /api/whatsapp/templates still reaches its auth', async () => {
    const res = await call(templatesRoute, { method: 'GET', query: { company_id: 'c1' } });
    expect(res.body?.code).not.toBe(WHATSAPP_NOT_AVAILABLE);
    expect(calls).toContain('auth:enforceCompanyAccess');
  });

  it('GET /api/whatsapp/broadcasts/[id] still reads the broadcast', async () => {
    const res = await call(idRoute, { method: 'GET', query: { id: 'b1' } });
    expect(res.body?.code).not.toBe(WHATSAPP_NOT_AVAILABLE);
    expect(calls).toContain('db:whatsapp_broadcasts');
  });
});

describe('the service send seams refuse under the routes (belt and braces)', () => {
  const seams: Array<[string, () => Promise<unknown>]> = [
    ['enqueueBroadcast', () => enqueueBroadcast('b1', 'free')],
    ['retryFailed', () => retryFailed('b1')],
    ['processBatch (the only Meta send seam)', () => processBatch('b1', ['r1'])],
  ];

  for (const [name, run] of seams) {
    it(`OFF: ${name} throws WhatsAppNotAvailableError before any read or provider call`, async () => {
      setFlag(undefined);
      const err = await run().then(() => null, (e) => e);
      expect(err).toBeInstanceOf(WhatsAppNotAvailableError);
      expect(err.code).toBe(WHATSAPP_NOT_AVAILABLE);
      expect(err.retryable).toBe(false);
      expect(calls).toEqual([]);
      expect(fetchCalls).toEqual([]);
    });

    it(`ON: ${name} proceeds past the gate (it reads the database)`, async () => {
      setFlag('true');
      await run().catch(() => undefined);   // the empty fake DB makes it fail later; only the gate matters here
      expect(calls.some((c) => c.startsWith('db:'))).toBe(true);
    });
  }
});

describe('GET /api/whatsapp/status', () => {
  it('unauthenticated -> 401', async () => {
    setFlag('true');
    const res = await call(statusRoute, { method: 'GET' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toHaveProperty('enabled');
  });

  it.each([[undefined, false], ['TRUE', false], [' true', false], ['true', true]])(
    'flag %j -> 200 { enabled: %s }, uncached', async (v, enabled) => {
      setFlag(v as string | undefined);
      const res = await call(statusRoute, { method: 'GET', headers: { authorization: 'Bearer any-user' } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ enabled });
      expect(res.headers['Cache-Control']).toBe('no-store');
    });

  it('other methods -> 405', async () => {
    const res = await call(statusRoute, { method: 'POST', headers: { authorization: 'Bearer any-user' } });
    expect(res.statusCode).toBe(405);
  });
});
