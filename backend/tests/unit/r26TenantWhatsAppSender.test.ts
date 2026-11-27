/**
 * R26 T-5 — WhatsApp adapter: the tenant's sender or nothing, and only behind WHATSAPP_CONNECT_ENABLED.
 *
 * At 2bc52db7a whatsappAdapter addressed process.env.WHATSAPP_PHONE_NUMBER_ID (Omnivyra's number) with the tenant's
 * token, defaulted the recipient to process.env.WHATSAPP_RECIPIENT_PHONE, and was not gated. Every test here sets
 * BOTH platform env values, so a fallback would be visible as a call.
 *
 * Failing controls at 2bc52db7a: the "no tenant phone id", "no recipient" and "gate off" cases each make one call
 * (to the platform number / platform recipient) instead of zero.
 */
const calls: Array<{ url: string; body: any }> = [];
jest.mock('../../services/platformAdapters/baseAdapter', () => ({
  withRateLimit: async (_k: string, fn: () => Promise<unknown>) => fn(),
  enforcePublishPolicy: () => undefined,
  fetchJsonWithBearer: jest.fn(async (url: string, _token: string, opts?: { init?: { body?: string } }) => {
    calls.push({ url, body: opts?.init?.body ? JSON.parse(opts.init.body) : undefined });
    return { messages: [{ id: 'wamid.1' }] };
  }),
}));

import { whatsappAdapter } from '../../services/platformAdapters/whatsappAdapter';

const PLATFORM_PHONE = 'PLATFORM_PHONE_ID_fixture';
const PLATFORM_RCPT = '15550000000';
const TENANT_PHONE = 'TENANT_PHONE_ID_fixture';

const ORIGINAL_ENV = { ...process.env };
const fetchSpy = jest.fn();
const ORIGINAL_FETCH = global.fetch;
beforeEach(() => {
  calls.length = 0;
  fetchSpy.mockReset();
  (global as any).fetch = fetchSpy;
  process.env.WHATSAPP_PHONE_NUMBER_ID = PLATFORM_PHONE;
  process.env.WHATSAPP_RECIPIENT_PHONE = PLATFORM_RCPT;
  process.env.WHATSAPP_CONNECT_ENABLED = 'true';
  delete process.env.USE_MOCK_PLATFORMS;
});
afterAll(() => { process.env = ORIGINAL_ENV; (global as any).fetch = ORIGINAL_FETCH; });

const tenantCreds = (phone?: string) => ({ access_token: 'tenant-token', ...(phone ? { phone_number_id: phone } : {}) }) as any;

describe('publishContent', () => {
  it('NO PLATFORM FALLBACK: a tenant without its own phone_number_id is refused, 0 calls', async () => {
    const r = await whatsappAdapter.publishContent({ content: 'hi', platform_post_id: '15551112222' }, tenantCreds());
    expect(r.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('NO DEFAULT RECIPIENT: a missing recipient is refused, 0 calls (never WHATSAPP_RECIPIENT_PHONE)', async () => {
    const r = await whatsappAdapter.publishContent({ content: 'hi' }, tenantCreds(TENANT_PHONE));
    expect(r).toEqual({ success: false, error: 'WHATSAPP_RECIPIENT_REQUIRED' });
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, 'false', '1', 'TRUE'])('FAIL CLOSED: WHATSAPP_CONNECT_ENABLED=%s refuses with WHATSAPP_NOT_AVAILABLE, 0 calls', async (flag) => {
    if (flag === undefined) delete process.env.WHATSAPP_CONNECT_ENABLED;
    else process.env.WHATSAPP_CONNECT_ENABLED = flag;
    const r = await whatsappAdapter.publishContent({ content: 'hi', platform_post_id: '15551112222' }, tenantCreds(TENANT_PHONE));
    expect(r).toEqual({ success: false, error: 'WHATSAPP_NOT_AVAILABLE' });
    expect(calls).toHaveLength(0);
  });

  it('CONTROL: gate on + tenant phone id + recipient -> exactly one send, from the TENANT number, to that recipient', async () => {
    const r = await whatsappAdapter.publishContent({ content: 'hi', platform_post_id: '15551112222' }, tenantCreds(TENANT_PHONE));
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/${TENANT_PHONE}/messages`);
    expect(calls[0].url).not.toContain(PLATFORM_PHONE);
    expect(calls[0].body.to).toBe('15551112222');
  });
});

describe('replyToComment and fetchComments', () => {
  it('replyToComment without a tenant phone id is refused, 0 calls', async () => {
    const r = await whatsappAdapter.replyToComment('15551112222', 'hello', tenantCreds());
    expect(r.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('replyToComment with the gate off is refused, 0 calls', async () => {
    process.env.WHATSAPP_CONNECT_ENABLED = 'false';
    const r = await whatsappAdapter.replyToComment('15551112222', 'hello', tenantCreds(TENANT_PHONE));
    expect(r).toEqual({ success: false, error: 'WHATSAPP_NOT_AVAILABLE' });
    expect(calls).toHaveLength(0);
  });

  it('fetchComments never reads the platform number (no tenant phone id -> empty, 0 fetches)', async () => {
    const r = await whatsappAdapter.fetchComments({ platformPostId: 'p1', accessToken: 'tenant-token' });
    expect(r).toEqual({ data: [], messaging_product: 'whatsapp' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
