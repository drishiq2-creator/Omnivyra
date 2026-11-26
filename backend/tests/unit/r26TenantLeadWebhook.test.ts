/**
 * R26 T-3 — the lead-webhook secret no longer serves two trust directions.
 *
 * At 2bc52db7a:
 *   - OUTBOUND: testConnection / sendLead sent the raw `secret` as X-Webhook-Secret to the tenant's third-party
 *     webhook_url (Zapier, Make, a CRM);
 *   - INBOUND: the same `secret` authenticated POST /api/leads (validateWebhookAuth).
 * So whoever could read the hook's request log could inject leads.
 *
 * Now (round 26 final, owner decisions):
 *   - per-integration signing_mode legacy | dual | signed; new integrations 'signed', pre-R26 rows 'legacy';
 *     LEAD_WEBHOOK_LEGACY_SUNSET turns legacy/dual into signed; dual logs + shows a deprecation warning;
 *   - every delivery carries X-Omnivyra-Signature t=…,v1=HMAC("<t>.<body>") and X-Webhook-Signature HMAC(body);
 *   - webhook destinations are https:// only (loopback http only under NODE_ENV development/test), at write and send;
 *   - inbound accepts a separate `inbound_secret` and, once one is set, refuses the outbound one.
 *
 * Failing controls at 2bc52db7a: every 'signed'/sunset case sees X-Webhook-Secret == secret and no signature; http://
 * destinations are accepted and delivered to; the inbound case accepts the outbound secret and refuses the inbound one.
 */
import crypto from 'crypto';

let mergedConfig: Record<string, string> = {};
let storedRow: Record<string, unknown> = {};
const credentialWrites: Array<Record<string, string>> = [];
const inserted: Array<Record<string, any>> = [];
/** Every write by table (integration review M-3: the refusal must leave a visible trace). */
const writes: Array<{ table: string; op: string; payload: Record<string, any> }> = [];

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const st: { op: string; payload?: Record<string, unknown> } = { op: 'select' };
    const chain: any = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      update: (p: Record<string, unknown>) => { st.op = 'update'; st.payload = p; writes.push({ table, op: 'update', payload: p as any }); return chain; },
      insert: (p: Record<string, unknown>) => {
        st.op = 'insert'; st.payload = p; writes.push({ table, op: 'insert', payload: p as any });
        if (table === 'company_integrations') inserted.push(p);
        return chain;
      },
      single: async () => ({
        data: st.op === 'insert' ? { id: 'int-new', ...st.payload } : st.op === 'update' ? { ...storedRow, ...st.payload } : storedRow,
        error: null,
      }),
      maybeSingle: async () => ({ data: storedRow, error: null }),
      then: (ok: any, ko: any) => Promise.resolve({ data: null, error: null }).then(ok, ko),
    };
    return chain;
  },
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
jest.mock('../../services/integrationCredentialService', () => {
  const actual = jest.requireActual('../../services/integrationCredentialService');
  return {
    ...actual,
    mergeConnectionConfig: jest.fn(async (_c: string, _id: string, nonSecret: Record<string, string>) => ({ ...nonSecret, ...mergedConfig })),
    upsertConnectionCredentials: jest.fn(async (_c: string, _id: string, creds: Record<string, string>) => { credentialWrites.push({ ...creds }); }),
  };
});
jest.mock('../../services/websiteService', () => ({
  createWebsiteConnection: jest.fn(async () => ({ id: 'conn-new' })),
  resolveWebsiteForCompany: jest.fn(async () => ({ id: 'web-1' })),
}));
jest.mock('../../services/cms/registry', () => ({ getCmsAdapter: jest.fn(), isCmsProvider: () => false }));
jest.mock('../../services/cms/cmsConnectionNormalizationService', () => ({ ensureCanonicalConnectionForIntegration: jest.fn() }));
jest.mock('../../../lib/identity/identityGateway', () => ({ ensureUnifiedPerson: jest.fn() }));
jest.mock('../../services/leadIntelligence/leadIntelligenceRuntime', () => ({ adoptLead: jest.fn() }));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: jest.fn() }));
jest.mock('../../services/leadIntelligence/legacyLeadCompat', () => ({ getLegacyLeads: jest.fn() }));

const sent: Array<{ url: string; init: any }> = [];
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: jest.fn(async (url: string, init: any) => { sent.push({ url, init }); return { ok: true, status: 200 }; }),
}));

import {
  validateIntegration,
  sendLead,
  updateIntegration,
  createIntegration,
  toPublicIntegration,
  verifyTimestampedLeadWebhookSignature,
} from '../../services/integrationService';
import { validateWebhookAuth } from '../../services/leadService';

const OUT = 'whsec_OUTBOUND_fixture';
const IN = 'whin_INBOUND_fixture';
const hmac = (body: string, key: string) => crypto.createHmac('sha256', key).update(body).digest('hex');
/** Independent receiver-side check of X-Omnivyra-Signature (does not reuse the sender's code). */
function receiverVerifies(header: string | undefined, body: string, key: string, nowS: number): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  if (Math.abs(nowS - Number(m[1])) > 300) return false;
  return m[2] === crypto.createHmac('sha256', key).update(`${m[1]}.${body}`).digest('hex');
}

function setRow(config: Record<string, string>, secrets: Record<string, string>) {
  storedRow = {
    id: 'int-1', company_id: 'co-A', created_by: 'u0', type: 'lead_webhook', name: 'Hook', status: 'connected',
    website_id: null, website_connection_id: 'conn-1', config, non_secret_config: config,
  };
  mergedConfig = secrets;
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  sent.length = 0;
  credentialWrites.length = 0;
  inserted.length = 0;
  writes.length = 0;
  delete process.env.LEAD_WEBHOOK_LEGACY_SUNSET;
  delete process.env.LEAD_WEBHOOK_INBOUND_REQUIRE_SEPARATE_SECRET;
  (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
});
afterAll(() => { process.env = ORIGINAL_ENV; });

function headerValues(init: any): string[] {
  return Object.values((init?.headers ?? {}) as Record<string, string>);
}

describe('OUTBOUND (test connection + sendLead): signing modes', () => {
  it.each([
    ['validateIntegration (Test button)', () => validateIntegration('int-1', 'co-A')],
    ['sendLead', () => sendLead('co-A', { name: 'L', email: 'l@example.com' })],
  ])('%s, signing_mode=signed: no header carries the secret; both signatures verify', async (_n, run) => {
    setRow({ webhook_url: 'https://hooks.example/abc', signing_mode: 'signed' }, { secret: OUT });
    const nowS = Math.floor(Date.now() / 1000);
    await run();
    expect(sent).toHaveLength(1); // non-vacuity: a delivery was made
    const { init } = sent[0];
    expect(headerValues(init)).not.toContain(OUT);
    expect(JSON.stringify(init.headers)).not.toContain(OUT);
    expect(init.headers['X-Webhook-Secret']).toBeUndefined();
    expect(init.headers['X-Webhook-Signature']).toBe(hmac(init.body, OUT));
    expect(receiverVerifies(init.headers['X-Omnivyra-Signature'], init.body, OUT, nowS)).toBe(true);
  });

  it('BACKWARD COMPATIBLE: a row with no mode (every pre-R26 row) is legacy and still sends X-Webhook-Secret, plus both signatures', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc' }, { secret: OUT });
    await validateIntegration('int-1', 'co-A');
    expect(sent).toHaveLength(1);
    expect(sent[0].init.headers['X-Webhook-Secret']).toBe(OUT);
    expect(sent[0].init.headers['X-Webhook-Signature']).toBe(hmac(sent[0].init.body, OUT));
    expect(sent[0].init.headers['X-Omnivyra-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('dual: raw header still sent, a deprecation warning is LOGGED on the send and VISIBLE in the admin response', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    setRow({ webhook_url: 'https://hooks.example/abc', signing_mode: 'dual' }, { secret: OUT });
    await validateIntegration('int-1', 'co-A');
    expect(sent[0].init.headers['X-Webhook-Secret']).toBe(OUT);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('DEPRECATED'))).toBe(true);
    const status = toPublicIntegration({ ...(storedRow as any), config: { webhook_url: 'https://hooks.example/abc', signing_mode: 'dual', secret: OUT } }).webhook_signing;
    expect(status).toMatchObject({ configured_mode: 'dual', effective_mode: 'dual', raw_secret_sent: true });
    expect(status?.deprecation_warning).toMatch(/X-Webhook-Secret/);
    warn.mockRestore();
  });

  it.each(['legacy', 'dual', ''])('SUNSET passed: signing_mode=%s behaves as signed (no raw header)', async (mode) => {
    process.env.LEAD_WEBHOOK_LEGACY_SUNSET = '2020-01-01T00:00:00Z';
    setRow({ webhook_url: 'https://hooks.example/abc', ...(mode ? { signing_mode: mode } : {}) }, { secret: OUT });
    await validateIntegration('int-1', 'co-A');
    expect(sent).toHaveLength(1);
    expect(headerValues(sent[0].init)).not.toContain(OUT);
    const status = toPublicIntegration({ ...(storedRow as any), config: { ...(storedRow.config as any), secret: OUT } }).webhook_signing;
    expect(status).toMatchObject({ effective_mode: 'signed', raw_secret_sent: false, deprecation_warning: null });
  });

  it('CONTROL: a sunset in the future (or an unparseable one) changes nothing for legacy', async () => {
    for (const sunset of ['2999-01-01T00:00:00Z', 'not-a-date']) {
      sent.length = 0;
      process.env.LEAD_WEBHOOK_LEGACY_SUNSET = sunset;
      setRow({ webhook_url: 'https://hooks.example/abc', signing_mode: 'legacy' }, { secret: OUT });
      await validateIntegration('int-1', 'co-A');
      expect(sent[0].init.headers['X-Webhook-Secret']).toBe(OUT);
    }
  });

  it('the INBOUND secret is never sent outbound, in any mode', async () => {
    for (const mode of ['legacy', 'dual', 'signed']) {
      sent.length = 0;
      setRow({ webhook_url: 'https://hooks.example/abc', signing_mode: mode }, { secret: OUT, inbound_secret: IN });
      await validateIntegration('int-1', 'co-A');
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0].init)).not.toContain(IN);
    }
  });

  it('timestamp tolerance: the reference verifier rejects a signature older (or newer) than 5 minutes', () => {
    const body = '{"a":1}';
    const t = 1_800_000_000;
    const header = `t=${t},v1=${crypto.createHmac('sha256', OUT).update(`${t}.${body}`).digest('hex')}`;
    expect(verifyTimestampedLeadWebhookSignature(header, body, OUT, t + 299)).toBe(true);
    expect(verifyTimestampedLeadWebhookSignature(header, body, OUT, t + 301)).toBe(false);
    expect(verifyTimestampedLeadWebhookSignature(header, body, OUT, t - 301)).toBe(false);
    expect(verifyTimestampedLeadWebhookSignature(header, body + ' ', OUT, t)).toBe(false);
    expect(verifyTimestampedLeadWebhookSignature(header, body, 'wrong', t)).toBe(false);
  });
});

describe('new vs existing integrations', () => {
  it('a NEW lead webhook defaults to signed (stored signing_mode=signed)', async () => {
    await createIntegration('co-A', 'u1', 'lead_webhook', 'Hook', { webhook_url: 'https://hooks.example/abc', secret: OUT });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].non_secret_config.signing_mode).toBe('signed');
    expect(JSON.stringify(inserted[0])).not.toContain(OUT);
  });

  it('an edit that omits signing_mode keeps the stored one (never a silent downgrade to legacy)', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc', signing_mode: 'signed' }, { secret: OUT });
    const updated = await updateIntegration('int-1', 'co-A', { config: { webhook_url: 'https://hooks.example/new' } });
    expect((updated.non_secret_config as any).signing_mode).toBe('signed');
  });
});

describe('HTTPS-only destinations (write time and send time)', () => {
  it.each(['http://hooks.example/abc', 'ftp://hooks.example/abc', 'not a url'])('create with webhook_url=%s is refused', async (url) => {
    await expect(createIntegration('co-A', 'u1', 'lead_webhook', 'Hook', { webhook_url: url })).rejects.toThrow(/https|valid URL/);
    expect(inserted).toHaveLength(0);
  });

  it('update to http:// is refused, nothing stored', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc' }, { secret: OUT });
    await expect(updateIntegration('int-1', 'co-A', { config: { webhook_url: 'http://hooks.example/abc' } })).rejects.toThrow(/https/);
    expect(credentialWrites).toEqual([]);
  });

  it('SEND time: a stored http:// row is refused with WEBHOOK_HTTPS_REQUIRED and 0 deliveries (Test button and sendLead)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    setRow({ webhook_url: 'http://hooks.example/abc', signing_mode: 'signed' }, { secret: OUT });
    const r = await validateIntegration('int-1', 'co-A');
    expect(r).toMatchObject({ success: false, code: 'WEBHOOK_HTTPS_REQUIRED' });
    await sendLead('co-A', { name: 'L', email: 'l@example.com' });
    expect(sent).toHaveLength(0);
  });

  it.each(['http://localhost:3000/hook', 'http://127.0.0.1/hook', 'http://[::1]/hook'])('loopback %s is allowed under NODE_ENV=test', async (url) => {
    setRow({ webhook_url: url, signing_mode: 'signed' }, { secret: OUT });
    await validateIntegration('int-1', 'co-A');
    expect(sent).toHaveLength(1);
  });

  it('PRODUCTION: loopback http:// is refused too (never allowed in production)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    setRow({ webhook_url: 'http://localhost:3000/hook', signing_mode: 'signed' }, { secret: OUT });
    const r = await validateIntegration('int-1', 'co-A');
    expect(r).toMatchObject({ success: false, code: 'WEBHOOK_HTTPS_REQUIRED' });
    expect(sent).toHaveLength(0);
    await expect(createIntegration('co-A', 'u1', 'lead_webhook', 'Hook', { webhook_url: 'http://localhost/hook' })).rejects.toThrow(/https/);
  });
});

describe('INBOUND POST /api/leads auth (validateWebhookAuth)', () => {
  it('with an inbound_secret set, the OUTBOUND secret is refused', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc' }, { secret: OUT, inbound_secret: IN });
    await expect(validateWebhookAuth('int-1', OUT)).resolves.toBeNull();
  });

  it('CONTROL: with an inbound_secret set, the inbound secret is accepted', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc' }, { secret: OUT, inbound_secret: IN });
    await expect(validateWebhookAuth('int-1', IN)).resolves.toEqual({ company_id: 'co-A', website_id: null, integration_id: 'int-1' });
  });

  it('legacy row (no inbound_secret): the old secret still authenticates (no live sender breaks)', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc' }, { secret: OUT });
    await expect(validateWebhookAuth('int-1', OUT)).resolves.not.toBeNull();
  });

  it('owner flag LEAD_WEBHOOK_INBOUND_REQUIRE_SEPARATE_SECRET=true: a legacy row without inbound_secret is refused', async () => {
    process.env.LEAD_WEBHOOK_INBOUND_REQUIRE_SEPARATE_SECRET = 'true';
    setRow({ webhook_url: 'https://hooks.example/abc' }, { secret: OUT });
    await expect(validateWebhookAuth('int-1', OUT)).resolves.toBeNull();
  });

  it('missing credential: no secret at all is refused, whatever is presented', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc' }, {});
    await expect(validateWebhookAuth('int-1', '')).resolves.toBeNull();
    await expect(validateWebhookAuth('int-1', 'anything')).resolves.toBeNull();
  });
});

describe('edit = replace semantics (the UI never needs the plaintext)', () => {
  it('a blank secret on edit keeps the stored one (nothing written for it); a new value replaces it', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc' }, { secret: OUT, inbound_secret: IN });
    await updateIntegration('int-1', 'co-A', { config: { webhook_url: 'https://hooks.example/new', secret: '', inbound_secret: '' } });
    expect(credentialWrites).toEqual([{}]);
    await updateIntegration('int-1', 'co-A', { config: { webhook_url: 'https://hooks.example/new', secret: 'whsec_NEW' } });
    expect(credentialWrites[1]).toEqual({ secret: 'whsec_NEW' });
  });

  it('setting an inbound_secret equal to the STORED outbound secret is refused, even when the outbound field is left blank', async () => {
    setRow({ webhook_url: 'https://hooks.example/abc' }, { secret: OUT });
    await expect(updateIntegration('int-1', 'co-A', { config: { webhook_url: 'https://hooks.example/abc', secret: '', inbound_secret: OUT } }))
      .rejects.toThrow(/inbound_secret must differ/);
    expect(credentialWrites).toEqual([]);
  });
});

describe('M-3: an http:// lead webhook is never dropped silently', () => {
  it('a refused delivery marks the integration failed with WEBHOOK_HTTPS_REQUIRED, and audits it (sendLead)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    setRow({ webhook_url: 'http://hooks.example/abc', signing_mode: 'signed' }, { secret: OUT });
    await sendLead('co-A', { name: 'L', email: 'l@example.com' });
    expect(sent).toHaveLength(0);
    const mark = writes.find((w) => w.table === 'company_integrations' && w.op === 'update');
    expect(mark?.payload).toMatchObject({ status: 'failed' });
    expect(String(mark?.payload.last_error)).toMatch(/^WEBHOOK_HTTPS_REQUIRED: /);
    const audit = writes.find((w) => w.table === 'audit_events' && w.op === 'insert');
    expect(audit?.payload).toMatchObject({ action: 'lead_webhook.delivery_refused', resource_id: 'int-1', severity: 'warning' });
  });

  it('the Test button refusal is audited and returns an actionable message (validateIntegration persists it as failed)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    setRow({ webhook_url: 'http://hooks.example/abc', signing_mode: 'signed' }, { secret: OUT });
    const r = await validateIntegration('int-1', 'co-A');
    expect(r.message).toMatch(/https:\/\/ Webhook URL/);
    expect(writes.some((w) => w.table === 'audit_events' && w.payload.action === 'lead_webhook.delivery_refused')).toBe(true);
    const persisted = writes.filter((w) => w.table === 'company_integrations' && w.op === 'update').pop();
    expect(persisted?.payload).toMatchObject({ status: 'failed' });
    expect(String(persisted?.payload.last_error)).toMatch(/WEBHOOK_HTTPS_REQUIRED/);
  });

  it('the admin sees webhook_destination {ok:false, code, reason} on the integration', () => {
    const pub = toPublicIntegration({ ...(storedRow as any), id: 'int-1', type: 'lead_webhook', config: { webhook_url: 'http://hooks.example/abc' } });
    expect(pub.webhook_destination).toEqual({ ok: false, code: 'WEBHOOK_HTTPS_REQUIRED', reason: 'webhook_url must use https://' });
    const ok = toPublicIntegration({ ...(storedRow as any), id: 'int-1', type: 'lead_webhook', config: { webhook_url: 'https://hooks.example/abc' } });
    expect(ok.webhook_destination).toEqual({ ok: true });
  });

  it('editing the http:// webhook to an https:// URL WORKS (the fix path is open)', async () => {
    setRow({ webhook_url: 'http://hooks.example/abc', signing_mode: 'signed' }, { secret: OUT });
    await expect(updateIntegration('int-1', 'co-A', { config: { webhook_url: 'https://hooks.example/abc' } })).resolves.toBeDefined();
    expect(credentialWrites).toHaveLength(1);
  });

  it('a rename alone works on an http:// row; other config edits while the URL stays http:// get a clear 400 message', async () => {
    setRow({ webhook_url: 'http://hooks.example/abc', signing_mode: 'signed' }, { secret: OUT });
    await expect(updateIntegration('int-1', 'co-A', { name: 'Renamed' })).resolves.toBeDefined();
    await expect(updateIntegration('int-1', 'co-A', { config: { webhook_url: 'http://hooks.example/abc', secret: 'whsec_NEW' } }))
      .rejects.toThrow(/https:\/\/ Webhook URL to save this integration/);
  });
});
