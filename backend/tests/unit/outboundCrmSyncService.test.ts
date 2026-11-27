/**
 * Round 12 (Agent A): outbound CRM sync — security + idempotency.
 *
 * Hermetic: audit_events and company_integrations are in-memory fakes behind
 * the real complianceAuditService/auditEventService; safeFetch is a jest mock.
 * No network, no database, no real credentials (all tokens are synthetic).
 *
 * FAILING CONTROL: set OUTBOUND_CRM_SUT to a module path holding the
 * 2bc52db7a copy of the service (see A-OUTBOUND-CRM-REMEDIATION.md §8). Every
 * test tagged [fix] must FAIL there; tests tagged [pin] guard behaviour that
 * was already correct and are expected to pass on both.
 */
import crypto from 'crypto';

type Row = Record<string, any>;
const mockDb: {
  audit: Row[];
  integrations: Row[];
  failReads: boolean;
  failInserts: boolean;
  leakIntegrations: boolean;
} = { audit: [], integrations: [], failReads: false, failInserts: false, leakIntegrations: false };

function mockAuditTable() {
  return {
    insert: async (row: Row) => {
      if (mockDb.failInserts) return { error: { message: 'insert failed (synthetic)' } };
      mockDb.audit.push({ ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() });
      return { error: null };
    },
    select: () => {
      const filters: Array<(r: Row) => boolean> = [];
      const q: any = {
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return q; },
        order: () => q,
        limit: () => q,
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          const out = mockDb.failReads
            ? { data: null, error: { message: 'read failed (synthetic)' } }
            : { data: mockDb.audit.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
          return Promise.resolve(out).then(ok, ko);
        },
      };
      return q;
    },
  };
}

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    if (table !== 'audit_events') throw new Error(`unexpected table ${table}`);
    return mockAuditTable();
  },
}));

jest.mock('../../services/integrationService', () => ({
  getIntegrations: async (companyId: string, type: string) =>
    mockDb.integrations.filter((r) => (mockDb.leakIntegrations || r.company_id === companyId) && r.type === type),
  getActiveIntegration: async (companyId: string, type: string) =>
    mockDb.integrations.find((r) => (mockDb.leakIntegrations || r.company_id === companyId) && r.type === type && r.status === 'connected') ?? null,
}));

const mockSafeFetch = jest.fn();
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: (...a: unknown[]) => mockSafeFetch(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sut = require(process.env.OUTBOUND_CRM_SUT || '../../services/intelligence/outboundCrmSyncService');
const syncToCrm: (i: any) => Promise<any> = sut.syncToCrm;
const buildOutboundCrmReport: (c: string) => Promise<any> = sut.buildOutboundCrmReport;

const ORG_A = '0eda0896-7814-4613-8b49-4a8f408e45f1';
const ORG_B = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const USER = '11111111-2222-4333-8444-555555555555';
const SECRET = 'synthetic-signing-secret';
const ENV_KEYS = ['HUBSPOT_CRM_ACCESS_TOKEN', 'SALESFORCE_ACCESS_TOKEN', 'SALESFORCE_INSTANCE_URL', 'ZOHO_CRM_ACCESS_TOKEN'];

function webhook(companyId: string, over: Row = {}): Row {
  return {
    id: over.id ?? crypto.randomUUID(), company_id: companyId, type: 'lead_webhook', status: 'connected',
    config: { webhook_url: `https://hooks.example.test/${companyId.slice(0, 4)}`, secret: SECRET }, ...over,
  };
}
const ok = (status = 200) => ({ status, ok: status >= 200 && status < 300, body: null, headers: { get: () => null } });
const op = (over: Row = {}) => ({
  companyId: ORG_A, provider: 'webhook_only', leadId: 'lead-1', event: 'create',
  payload: { email: 'a@example.test', firstname: 'Ada' }, actor: { userId: USER }, ...over,
});
const lostResponse = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });

beforeEach(() => {
  mockDb.audit = []; mockDb.integrations = []; mockDb.failReads = false; mockDb.failInserts = false; mockDb.leakIntegrations = false;
  mockSafeFetch.mockReset();
  mockSafeFetch.mockResolvedValue(ok(200));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterAll(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe('platform credentials are never used', () => {
  it('[fix] hubspot with HUBSPOT_CRM_ACCESS_TOKEN in process.env: refused, no network call', async () => {
    process.env.HUBSPOT_CRM_ACCESS_TOKEN = 'synthetic-platform-token';
    const r = await syncToCrm(op({ provider: 'hubspot' }));
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('refused');
  });

  it('[fix] salesforce and zoho with platform env tokens: refused, no network call', async () => {
    process.env.SALESFORCE_ACCESS_TOKEN = 'synthetic-sf-token';
    process.env.SALESFORCE_INSTANCE_URL = 'https://platform.my.salesforce.example';
    process.env.ZOHO_CRM_ACCESS_TOKEN = 'synthetic-zoho-token';
    const sf = await syncToCrm(op({ provider: 'salesforce' }));
    const zo = await syncToCrm(op({ provider: 'zoho' }));
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect([sf.status, zo.status]).toEqual(['refused', 'refused']);
  });

  it('[fix] a caller instanceUrl can never receive the platform token (partial-merge path is gone)', async () => {
    process.env.SALESFORCE_ACCESS_TOKEN = 'synthetic-sf-token';
    process.env.SALESFORCE_INSTANCE_URL = 'https://platform.my.salesforce.example';
    const r = await syncToCrm(op({ provider: 'salesforce', credentials: { instanceUrl: 'https://attacker.example.test' } }));
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('refused');
  });

  it('[fix] caller-supplied webhookUrl is refused even when the tenant has its own webhook', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    const r = await syncToCrm(op({ credentials: { webhookUrl: 'https://attacker.example.test/x', signingSecret: 'x' } }));
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('refused');
  });

  it('[fix] GET report does not reveal platform env presence', async () => {
    for (const k of ENV_KEYS) process.env[k] = 'synthetic';
    const rep = await buildOutboundCrmReport(ORG_A);
    expect(rep.capabilityFlags).toEqual({ hubspot: false, salesforce: false, zoho: false, webhook_only: false });
  });

  it('[pin] control: the GET report still reports the tenant\'s own webhook as usable', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    const rep = await buildOutboundCrmReport(ORG_A);
    expect(rep.capabilityFlags.webhook_only).toBe(true);
  });
});

describe('destination ownership (webhook_only)', () => {
  it('[pin] no lead_webhook row: not_configured, no network call', async () => {
    const r = await syncToCrm(op());
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('not_configured');
  });

  it('[fix] two connected rows (ambiguous): refused, no network call', async () => {
    mockDb.integrations = [webhook(ORG_A), webhook(ORG_A, { config: { webhook_url: 'https://other.example.test/h', secret: SECRET } })];
    const r = await syncToCrm(op());
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('refused');
  });

  it('[fix] a row of ANOTHER company returned by the store: refused, no network call', async () => {
    mockDb.leakIntegrations = true;
    mockDb.integrations = [webhook(ORG_B)];
    const r = await syncToCrm(op());
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('refused');
  });

  it('[fix] a non-https destination: refused, no network call', async () => {
    mockDb.integrations = [webhook(ORG_A, { config: { webhook_url: 'http://hooks.example.test/a', secret: SECRET } })];
    const r = await syncToCrm(op());
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('refused');
  });

  it('[pin] a disconnected row is not a destination', async () => {
    mockDb.integrations = [webhook(ORG_A, { status: 'failed' })];
    const r = await syncToCrm(op());
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('not_configured');
  });
});

describe('webhook_only happy path', () => {
  it('[pin] posts {leadId,event,payload} to the tenant URL with an HMAC-SHA256 signature', async () => {
    const row = webhook(ORG_A);
    mockDb.integrations = [row];
    const r = await syncToCrm(op());
    expect(r.status).toBe('synced');
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockSafeFetch.mock.calls[0];
    expect(url).toBe(row.config.webhook_url);
    expect(JSON.parse(init.body)).toEqual({ leadId: 'lead-1', event: 'create', payload: { email: 'a@example.test', firstname: 'Ada' } });
    expect(init.headers['X-Webhook-Signature']).toBe(crypto.createHmac('sha256', SECRET).update(init.body).digest('hex'));
    // control: a different secret does not match the signature
    expect(init.headers['X-Webhook-Signature']).not.toBe(crypto.createHmac('sha256', 'other').update(init.body).digest('hex'));
  });

  it('[fix] redirects are refused at the call site (maxRedirects: 0)', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    await syncToCrm(op());
    expect(mockSafeFetch.mock.calls[0][2]).toEqual(expect.objectContaining({ maxRedirects: 0 }));
  });

  it('[fix] the audit row records the acting user, not "system"', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    await syncToCrm(op());
    const synced = mockDb.audit.filter((a) => a.metadata?.outcome === 'synced');
    expect(synced).toHaveLength(1);
    expect(synced[0]).toEqual(expect.objectContaining({ actor_user_id: USER, actor_type: 'user', company_id: ORG_A }));
  });
});

describe('dedupe key', () => {
  const keyOf = async (over: Row) => (await syncToCrm(op(over))).dedupeKey as string;

  it('[pin] same logical operation -> same key, second call is deduped without sending', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    const a = await syncToCrm(op());
    const b = await syncToCrm(op({ payload: { firstname: 'Ada', email: 'a@example.test' } })); // key order differs
    expect(a.status).toBe('synced');
    expect(b.status).toBe('deduped');
    expect(b.dedupeKey).toBe(a.dedupeKey);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('[fix] different leads, events, payloads (incl. nested) -> different keys', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    const keys = [
      await keyOf({}),
      await keyOf({ leadId: 'lead-2' }),
      await keyOf({ event: 'update' }),
      await keyOf({ payload: { email: 'b@example.test', firstname: 'Ada' } }),
      await keyOf({ payload: { email: 'a@example.test', firstname: 'Ada', extra: { deep: [1, 2] } } }),
      await keyOf({ payload: { email: 'a@example.test', firstname: 'Ada', extra: { deep: [2, 1] } } }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(mockSafeFetch).toHaveBeenCalledTimes(keys.length); // none wrongly deduped
  });

  it('[fix] different tenants with identical records -> different keys, both sent', async () => {
    mockDb.integrations = [webhook(ORG_A), webhook(ORG_B)];
    const a = await syncToCrm(op({ companyId: ORG_A }));
    const b = await syncToCrm(op({ companyId: ORG_B }));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect([a.status, b.status]).toEqual(['synced', 'synced']);
  });

  it('[fix] a changed destination URL -> different key (the op is resent to the new destination)', async () => {
    const row = webhook(ORG_A);
    mockDb.integrations = [row];
    const a = await syncToCrm(op());
    row.config = { webhook_url: 'https://new-hooks.example.test/a', secret: SECRET };
    const b = await syncToCrm(op());
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect(b.status).toBe('synced');
  });

  it('[fix] the key is versioned (v2) and a full sha256 hex; it carries no URL or payload in clear', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    const k = await keyOf({});
    expect(k).toMatch(/^crm_outbound:v2:[0-9a-f]{64}$/);
  });
});

describe('retry and lost-response semantics', () => {
  it('[fix] a received non-2xx is definitive: the same op may be retried and then syncs', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    mockSafeFetch.mockResolvedValueOnce(ok(500));
    const first = await syncToCrm(op());
    const second = await syncToCrm(op());
    expect(first.status).toBe('failed');
    expect(second.status).toBe('synced');
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('[fix] a pre-send failure (DNS validation) is definitive and retryable', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    mockSafeFetch.mockRejectedValueOnce(Object.assign(new Error('SSRF blocked'), { name: 'SsrfBlockedError', reason: 'dns_resolution_failed' }));
    const first = await syncToCrm(op());
    const second = await syncToCrm(op());
    expect(first).toEqual(expect.objectContaining({ status: 'failed', retryable: true }));
    expect(second.status).toBe('synced');
  });

  it('[fix] not_configured never poisons a later push (old constant key did)', async () => {
    const r1 = await syncToCrm(op({ provider: 'hubspot' }));
    const r2 = await syncToCrm(op()); // no webhook yet
    mockDb.integrations = [webhook(ORG_A)];
    const r3 = await syncToCrm(op());
    expect(r1.status).not.toBe('synced');
    expect(r2.status).toBe('not_configured');
    expect(r3.status).toBe('synced');
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('[fix] a lost response is recorded unknown and BLOCKS automatic resend', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    mockSafeFetch.mockRejectedValueOnce(lostResponse());
    const first = await syncToCrm(op());
    const second = await syncToCrm(op());
    expect(first).toEqual(expect.objectContaining({ status: 'unknown', retryable: false }));
    expect(first.detail).not.toMatch(/try again/i);
    expect(second.status).toBe('unknown');
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockDb.audit.some((a) => a.metadata?.outcome === 'unknown')).toBe(true);
  });

  it('[fix] a refused redirect (response arrived, outcome unseen) is unknown, not failed', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    mockSafeFetch.mockRejectedValueOnce(Object.assign(new Error('SSRF blocked'), { name: 'SsrfBlockedError', reason: 'too_many_redirects' }));
    const r = await syncToCrm(op());
    expect(r.status).toBe('unknown');
  });

  it('[fix] an unresolved claim from another instance blocks sending', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    // Pre-compute lead-1's key by a run whose ledger read fails (nothing is sent).
    mockDb.failReads = true;
    const k = (await syncToCrm(op())).dedupeKey;
    mockDb.failReads = false;
    mockDb.audit.push({ company_id: ORG_A, resource_type: 'crm_outbound_sync_event', resource_id: k, metadata: { outcome: 'dispatching', attemptId: 'other-instance' } });
    const r = await syncToCrm(op());
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('unknown');
  });

  it('[fix] ledger read failure is not "never synced": nothing is sent', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    mockDb.failReads = true;
    const r = await syncToCrm(op());
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r).toEqual(expect.objectContaining({ status: 'failed', retryable: true }));
  });

  it('[fix] a claim that cannot be recorded is not sent', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    mockDb.failInserts = true;
    const r = await syncToCrm(op());
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('failed');
  });

  it('[fix] concurrent duplicate calls in one process send once', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    let release!: () => void;
    mockSafeFetch.mockImplementationOnce(() => new Promise((res) => { release = () => res(ok(200)); }));
    const p1 = syncToCrm(op());
    const p2 = syncToCrm(op());
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setImmediate(r));
    release?.();
    const [a, b] = await Promise.all([p1, p2]);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect([a.status, b.status].sort()).toEqual(['deduped', 'synced']);
  });
});

describe('backward compatibility and fail-closed edges', () => {
  it('[fix] a legacy marker under the old constant {}-hash key does not block new pushes', async () => {
    const legacyKey = `crm_outbound:${crypto.createHash('sha256').update('{}').digest('hex').slice(0, 32)}`;
    mockDb.audit.push({ company_id: ORG_A, resource_type: 'crm_outbound_sync_event', resource_id: legacyKey, metadata: { outcome: 'not_configured', provider: 'hubspot' } });
    mockDb.integrations = [webhook(ORG_A)];
    const r = await syncToCrm(op());
    expect(r.status).toBe('synced');
    expect(r.dedupeKey).not.toBe(legacyKey);
  });

  it('[fix] an unsupported provider fails closed (refused), no network call', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    const r = await syncToCrm(op({ provider: 'pipedrive' }));
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('refused');
  });

  it('[fix] a non-serialisable (cyclic) payload fails closed, no network call', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    const payload: Row = { email: 'a@example.test' };
    payload.self = payload;
    const r = await syncToCrm(op({ payload }));
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(r.status).toBe('refused');
  });

  it('[fix] the GET report counts terminal outcomes only and flags an unreadable ledger', async () => {
    mockDb.integrations = [webhook(ORG_A)];
    await syncToCrm(op());
    const rep = await buildOutboundCrmReport(ORG_A);
    expect(rep.syncedEvents).toBe(1);
    expect(rep.totalEvents).toBe(1);
    mockDb.failReads = true;
    const down = await buildOutboundCrmReport(ORG_A);
    expect(down.ledgerAvailable).toBe(false);
  });
});
