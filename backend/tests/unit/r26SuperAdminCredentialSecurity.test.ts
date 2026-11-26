/**
 * Round 26 (Agent C) — Super Admin credential security.
 *
 * Production (round 25 CT, shape only) held five raw provider keys in
 * `api_provider_accounts.credentials_encrypted`: one legacy PLAINTEXT `api_key_value`
 * (SerpAPI "SERPAPI_PRODUCTION") and four raw tokens inside `api_key_env_name` (SearchAPI,
 * YouTube, SerpAPI "default", OpenAI "default"). These tests pin that:
 *   1. a re-save through the provider-account routes converges every one of those five
 *      shapes to { api_key_env_name: <ENV NAME> | absent, api_key_value: <ciphertext> | absent };
 *   2. the write routes refuse a secret-shaped reference, unknown fields and plaintext refs,
 *      without echoing the value;
 *   3. GET/POST/PUT responses carry no credential material (only a shape-only state);
 *   4. api-presets writes validate references / headers / query params / base_url and need
 *      step-up for a base_url write;
 *   5. the Super Admin catalog UI no longer tells anyone to paste a key into a reference field.
 *
 * Every credential below is a synthetic sentinel of the production SHAPE, never a real key.
 * Failing controls: see the round-26 report (the route/UI suites fail against 2bc52db7a).
 */
import * as fs from 'fs';
import * as path from 'path';

// Synthetic sentinels with the production shapes (lengths from the CT shape check).
const FAKE_SERP_64 = 'f'.repeat(28) + '0123456789abcdef0123456789abcdef01aa'; // 64 hex, no cipher marker
const FAKE_SEARCHAPI_24 = 'Zq8xR2vT9kLm3NpW7sYb4Hc1'; // 24 mixed
const FAKE_YT_39 = 'AIzaSyFAKE0000000000000000000000000000x'.slice(0, 39); // 39, Google shape
const FAKE_SERP_65 = 'e'.repeat(33) + '0123456789abcdef0123456789abcdef'; // 65 hex-ish
const FAKE_OPENAI_164 = 'sk-proj-' + 'A1b2C3d4'.repeat(19) + 'Zz11'; // 164
const SENTINELS = [FAKE_SERP_64, FAKE_SEARCHAPI_24, FAKE_YT_39, FAKE_SERP_65, FAKE_OPENAI_164];

const CIPHER_RE = /^(?:k1:[0-9a-f]{8}:)?[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;

// ── Mocks ─────────────────────────────────────────────────────────────────────
const mockAccounts: Record<string, Record<string, unknown>> = {};
const mockSources: Record<string, Record<string, unknown>> = {};
let mockSourceReadError: unknown = null;
let mockReadError: unknown = null;
const mockUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
const mockCreates: Array<Record<string, unknown>> = [];

jest.mock('../../db/supabaseClient', () => {
  const builder = (table: string) => {
    let id: string | null = null;
    let wantsCreds = false;
    const b: Record<string, unknown> = {};
    b.select = (cols: string) => { wantsCreds = String(cols).includes('credentials_encrypted'); return b; };
    b.eq = (c: string, v: string) => { if (c === 'id') id = v; return b; };
    b.maybeSingle = async () => {
      if (table === 'external_api_sources') {
        if (mockSourceReadError) return { data: null, error: mockSourceReadError };
        return { data: id ? mockSources[id] ?? null : null, error: null };
      }
      if (table !== 'api_provider_accounts') return { data: null, error: null };
      if (wantsCreds && mockReadError) return { data: null, error: mockReadError };
      return { data: id ? mockAccounts[id] ?? null : null, error: null };
    };
    return b;
  };
  return { supabase: { from: (t: string) => builder(t) } };
});

jest.mock('../../services/providerAccountService', () => {
  const actual = jest.requireActual('../../services/providerAccountService');
  return {
    ...actual,
    listAccountsForApi: async (sourceId: string) =>
      Object.values(mockAccounts).filter((a) => a.api_source_id === sourceId),
    createProviderAccount: async (input: Record<string, unknown>) => {
      mockCreates.push(input);
      return { id: 'new-1', ...input, is_active: true };
    },
    updateProviderAccount: async (id: string, patch: Record<string, unknown>) => {
      mockUpdates.push({ id, patch });
      return { ...mockAccounts[id], ...patch };
    },
    deactivateProviderAccount: async () => undefined,
  };
});

const mockRequireCapability = jest.fn(async (_req: unknown, _res: unknown, _opts: unknown) => ({ ok: true, principal: { userId: 'u-admin' } }));
jest.mock('../../security/requireCapability', () => ({
  requireCapability: (req: unknown, res: unknown, opts: unknown) => mockRequireCapability(req, res, opts),
}));
jest.mock('../../security/platformWriteAuthority', () => ({ enforcePlatformWriteAuthority: async () => true }));
jest.mock('../../services/requestAccessService', () => ({ requireAdminRateLimit: async () => true }));
jest.mock('../../services/superAdminSession', () => ({ getLegacySuperAdminSession: () => ({ userId: 'u-admin' }) }));
jest.mock('../../services/supabaseAuthService', () => ({ getSupabaseUserFromRequest: async () => ({ user: null, error: 'NO_TOKEN' }) }));
jest.mock('../../services/rbacService', () => ({ isPlatformSuperAdmin: async () => true, isSuperAdmin: async () => true }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../middleware/requireSuperAdmin', () => ({ requireSuperAdmin: async () => true }));

const mockCreatePreset = jest.fn(async (p: Record<string, unknown>) => ({ id: 'p-1', name: p.name, base_url: p.base_url }));
const mockUpdatePreset = jest.fn(async (id: string, p: Record<string, unknown>) => ({ id, ...p }));
const mockSetPresetEnabled = jest.fn(async (id: string, a: boolean) => ({ id, is_active: a }));
jest.mock('../../services/intelligenceGovernanceService', () => ({
  listApiPresets: async () => [],
  createApiPreset: (p: Record<string, unknown>) => mockCreatePreset(p),
  updateApiPreset: (id: string, p: Record<string, unknown>) => mockUpdatePreset(id, p),
  setApiPresetEnabled: (id: string, a: boolean) => mockSetPresetEnabled(id, a),
}));

import { decryptCredential, encryptCredential } from '../../auth/credentialEncryption';
import providerAccountsRoute from '../../../pages/api/provider-accounts/index';
import providerAccountRoute from '../../../pages/api/provider-accounts/[id]';
import apiPresetsRoute from '../../../pages/api/admin/intelligence/api-presets';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(
  handler: Handler,
  method: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  let status = 0;
  let body: unknown;
  const res = {
    status(c: number) { status = c; return res; },
    json(b: unknown) { body = b; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  await handler({ method, headers: {}, query: opts.query ?? {}, body: opts.body, cookies: {}, url: '/x' }, res);
  return { status, body, text: JSON.stringify(body ?? null) };
}

function expectNoSentinel(text: string) {
  for (const s of SENTINELS) expect(text).not.toContain(s);
}

/** The five production envelope SHAPES (values are sentinels). */
function seedProductionShapes() {
  for (const k of Object.keys(mockAccounts)) delete mockAccounts[k];
  const enc = (v: string) => encryptCredential(v);
  mockAccounts['acct-serp-prod'] = {
    id: 'acct-serp-prod', api_source_id: 'src-serp', account_name: 'SERPAPI_PRODUCTION', priority: 1, is_active: true,
    credentials_encrypted: JSON.stringify({ api_key_env_name: 'SERPAPI_KEY', api_key_value: FAKE_SERP_64 }),
  };
  mockAccounts['acct-searchapi'] = {
    id: 'acct-searchapi', api_source_id: 'src-searchapi', account_name: 'default', priority: 1, is_active: true,
    credentials_encrypted: JSON.stringify({ api_key_env_name: FAKE_SEARCHAPI_24, api_key_value: enc('searchapi-real-encrypted') }),
  };
  mockAccounts['acct-youtube'] = {
    id: 'acct-youtube', api_source_id: 'src-youtube', account_name: 'default', priority: 1, is_active: true,
    credentials_encrypted: JSON.stringify({ api_key_env_name: FAKE_YT_39, api_key_value: enc('youtube-real-encrypted') }),
  };
  mockAccounts['acct-serp-default'] = {
    id: 'acct-serp-default', api_source_id: 'src-serp', account_name: 'default', priority: 2, is_active: false,
    credentials_encrypted: JSON.stringify({ api_key_env_name: FAKE_SERP_65 }),
  };
  mockAccounts['acct-openai'] = {
    id: 'acct-openai', api_source_id: 'src-openai', account_name: 'default', priority: 1, is_active: false,
    credentials_encrypted: JSON.stringify({ api_key_env_name: FAKE_OPENAI_164, api_key_value: enc('openai-real-encrypted') }),
  };
}

/** The body the Super Admin edit modal sends (credentials only when a field was typed). */
function uiEditBody(acct: Record<string, unknown>, credentials: Record<string, unknown>) {
  return {
    account_name: acct.account_name, credentials, priority: acct.priority, is_active: acct.is_active,
    rate_limit_per_min: null, rate_limit_per_day: null,
  };
}

function storedShape(envelope: string) {
  const o = JSON.parse(envelope) as Record<string, string>;
  return {
    keys: Object.keys(o).sort(),
    envOk: o.api_key_env_name === undefined || ENV_RE.test(o.api_key_env_name),
    valueOk: o.api_key_value === undefined || CIPHER_RE.test(o.api_key_value),
    o,
  };
}

beforeEach(() => {
  seedProductionShapes();
  for (const k of Object.keys(mockSources)) delete mockSources[k];
  for (const sid of ['src-serp', 'src-searchapi', 'src-youtube', 'src-openai', 'src', 's', 'src-ok']) {
    mockSources[sid] = { id: sid, company_id: null };
  }
  mockSources['src-tenant'] = { id: 'src-tenant', company_id: 'co-tenant-1' };
  mockSourceReadError = null;
  mockReadError = null;
  mockUpdates.length = 0;
  mockCreates.length = 0;
  mockRequireCapability.mockClear();
  mockRequireCapability.mockImplementation(async () => ({ ok: true, principal: { userId: 'u-admin' } }));
  mockCreatePreset.mockClear();
  mockUpdatePreset.mockClear();
  mockSetPresetEnabled.mockClear();
});

// ── 1. Re-save converges the five production shapes ─────────────────────────
describe('PUT /api/provider-accounts/[id] — re-saving the five production accounts', () => {
  it('(1) SERPAPI_PRODUCTION: re-entering the key stores ciphertext and keeps the env name', async () => {
    const acct = mockAccounts['acct-serp-prod'];
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-serp-prod' }, body: uiEditBody(acct, { api_key_value: 'rotated-serp-key-0000000000000000' }) });
    expect(r.status).toBe(200);
    const shape = storedShape(String(mockUpdates[0].patch.credentials_encrypted));
    expect(shape).toMatchObject({ keys: ['api_key_env_name', 'api_key_value'], envOk: true, valueOk: true });
    expect(shape.o.api_key_env_name).toBe('SERPAPI_KEY');
    expect(decryptCredential(shape.o.api_key_value)).toBe('rotated-serp-key-0000000000000000');
    expectNoSentinel(r.text);
    expect(r.text).not.toContain('rotated-serp-key');
  });

  it('(1b) SERPAPI_PRODUCTION: a save WITHOUT re-entering the key still encrypts the legacy plaintext (effective key unchanged)', async () => {
    const acct = mockAccounts['acct-serp-prod'];
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-serp-prod' }, body: uiEditBody(acct, {}) });
    expect(r.status).toBe(200);
    const shape = storedShape(String(mockUpdates[0].patch.credentials_encrypted));
    expect(shape).toMatchObject({ envOk: true, valueOk: true });
    expect(decryptCredential(shape.o.api_key_value)).toBe(FAKE_SERP_64);
    expect(String(mockUpdates[0].patch.credentials_encrypted)).not.toContain(FAKE_SERP_64);
  });

  it.each([
    ['acct-searchapi', 'SEARCHAPI_KEY', FAKE_SEARCHAPI_24, 'searchapi-real-encrypted'],
    ['acct-youtube', 'YOUTUBE_API_KEY', FAKE_YT_39, 'youtube-real-encrypted'],
    ['acct-openai', 'OPENAI_API_KEY', FAKE_OPENAI_164, 'openai-real-encrypted'],
  ])('(2/3/5) %s: setting a proper env name replaces the raw token and keeps the encrypted key', async (id, envName, token, plain) => {
    const acct = mockAccounts[id];
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id }, body: uiEditBody(acct, { api_key_env_name: envName }) });
    expect(r.status).toBe(200);
    const stored = String(mockUpdates[0].patch.credentials_encrypted);
    expect(stored).not.toContain(token);
    const shape = storedShape(stored);
    expect(shape.o.api_key_env_name).toBe(envName);
    expect(shape.valueOk).toBe(true);
    expect(decryptCredential(shape.o.api_key_value)).toBe(plain);
    expectNoSentinel(r.text);
  });

  it.each([
    ['acct-searchapi', FAKE_SEARCHAPI_24],
    ['acct-youtube', FAKE_YT_39],
    ['acct-openai', FAKE_OPENAI_164],
    ['acct-serp-default', FAKE_SERP_65],
  ])('(2-5) %s: ANY credential save drops the raw token from api_key_env_name (never carried forward)', async (id, token) => {
    const acct = mockAccounts[id];
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id }, body: uiEditBody(acct, {}) });
    expect(r.status).toBe(200);
    const stored = String(mockUpdates[0].patch.credentials_encrypted);
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored).api_key_env_name).toBeUndefined();
    expect(storedShape(stored).valueOk).toBe(true);
  });

  it('(4) SerpAPI "default" (inactive, no key): clearing the reference writes an empty envelope and keeps it inactive', async () => {
    const acct = mockAccounts['acct-serp-default'];
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-serp-default' }, body: uiEditBody(acct, { api_key_env_name: null }) });
    expect(r.status).toBe(200);
    expect(mockUpdates[0].patch.credentials_encrypted).toBe('{}');
    expect(mockUpdates[0].patch.is_active).toBe(false);
  });

  it('api_key_env_name: null clears a VALID reference too (explicit, not via empty string)', async () => {
    const acct = mockAccounts['acct-serp-prod'];
    await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-serp-prod' }, body: uiEditBody(acct, { api_key_env_name: null }) });
    expect(JSON.parse(String(mockUpdates[0].patch.credentials_encrypted)).api_key_env_name).toBeUndefined();
    // Control: an empty string still means "unchanged".
    mockUpdates.length = 0;
    seedProductionShapes();
    await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-serp-prod' }, body: uiEditBody(acct, { api_key_env_name: '' }) });
    expect(JSON.parse(String(mockUpdates[0].patch.credentials_encrypted)).api_key_env_name).toBe('SERPAPI_KEY');
  });

  it('a credential-free PUT (toggle / reorder) does not touch the envelope', async () => {
    await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-youtube' }, body: { priority: 3 } });
    expect(mockUpdates[0].patch).toEqual({ priority: 3 });
  });

  it('fails CLOSED when the current envelope cannot be read (never merges onto nothing)', async () => {
    mockReadError = { message: 'boom' };
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-youtube' }, body: { credentials: { api_key_value: 'new-key-000000000000' } } });
    expect(r.status).toBe(500);
    expect(mockUpdates).toHaveLength(0);
  });
});

// ── 2. Write routes refuse unsafe input without echoing it ──────────────────
describe('provider-accounts write validation', () => {
  it.each(SENTINELS)('PUT refuses a secret-shaped api_key_env_name (400, not echoed, nothing written)', async (token) => {
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-youtube' }, body: { credentials: { api_key_env_name: token } } });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('INVALID_ENV_VAR_NAME');
    expect(r.text).not.toContain(token);
    expect(mockUpdates).toHaveLength(0);
  });

  it('POST refuses a secret-shaped api_key_env_name (400, not echoed, nothing created)', async () => {
    const r = await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 'src-serp', account_name: 'x', credentials: { api_key_env_name: FAKE_SERP_64 } } });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(FAKE_SERP_64);
    expect(mockCreates).toHaveLength(0);
  });

  it('POST and PUT refuse a plaintext value submitted as an OAuth *_ref', async () => {
    const p = await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 'src', account_name: 'x', credentials: { oauth_client_secret_ref: 'plain-secret-value-123' } } });
    expect(p.status).toBe(400);
    expect((p.body as { error: string }).error).toBe('INVALID_CREDENTIAL_REF');
    expect(p.text).not.toContain('plain-secret-value-123');
    const u = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-youtube' }, body: { credentials: { oauth_client_id_ref: 'plain-client-id-123' } } });
    expect(u.status).toBe(400);
    expect(mockCreates).toHaveLength(0);
    expect(mockUpdates).toHaveLength(0);
  });

  it('refuses unknown credential fields and non-string values (a key under another name is never stored)', async () => {
    const a = await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 'src', account_name: 'x', credentials: { api_key: FAKE_SERP_64 } } });
    expect(a.status).toBe(400);
    expect((a.body as { error: string }).error).toBe('UNSUPPORTED_CREDENTIAL_FIELD');
    expect(a.text).not.toContain(FAKE_SERP_64);
    const b = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-youtube' }, body: { credentials: { api_key_value: 12345 } } });
    expect(b.status).toBe(400);
    expect(mockCreates).toHaveLength(0);
    expect(mockUpdates).toHaveLength(0);
  });

  it('POST encrypts api_key_value before persistence and keeps a valid env name readable', async () => {
    const r = await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 'src-serp', account_name: 'Primary', credentials: { api_key_env_name: 'SERPAPI_KEY', api_key_value: 'brand-new-key-000000000000' } } });
    expect(r.status).toBe(201);
    const shape = storedShape(String(mockCreates[0].credentials_encrypted));
    expect(shape).toMatchObject({ keys: ['api_key_env_name', 'api_key_value'], envOk: true, valueOk: true });
    expect(String(mockCreates[0].credentials_encrypted)).not.toContain('brand-new-key');
    expect(r.text).not.toContain('brand-new-key');
    expect(r.text).not.toContain(shape.o.api_key_value);
  });

  it('POST moves a direct OAuth secret into its encrypted ref (no plaintext OAuth at rest)', async () => {
    await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 'src', account_name: 'o', credentials: { oauth_client_id: 'cid-123456', oauth_client_secret: 'csecret-123456' } } });
    const o = JSON.parse(String(mockCreates[0].credentials_encrypted));
    expect(Object.keys(o).sort()).toEqual(['oauth_client_id_ref', 'oauth_client_secret_ref']);
    expect(CIPHER_RE.test(o.oauth_client_secret_ref)).toBe(true);
  });
});

// ── 2b. Platform accounts belong to platform sources only (round 26 final, S-3) ──
describe('provider accounts on a TENANT-owned source are refused', () => {
  function seedTenantAccount() {
    mockAccounts['acct-tenant'] = {
      id: 'acct-tenant', api_source_id: 'src-tenant', account_name: 'default', priority: 1, is_active: false,
      credentials_encrypted: JSON.stringify({ api_key_env_name: 'SERPAPI_KEY' }),
    };
  }

  it('scenario exists: the tenant source row is tenant-owned and the platform one is not', () => {
    expect(mockSources['src-tenant'].company_id).toBe('co-tenant-1');
    expect(mockSources['src-serp'].company_id).toBeNull();
  });

  it('POST on a tenant-owned source: 400 PROVIDER_ACCOUNT_TENANT_SOURCE, nothing created', async () => {
    const r = await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 'src-tenant', account_name: 'x', credentials: { api_key_value: 'k-000000000000' } } });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('PROVIDER_ACCOUNT_TENANT_SOURCE');
    expect(mockCreates).toHaveLength(0);
    expect(r.text).not.toContain('co-tenant-1');
  });

  it('control: POST on a platform source with the same body succeeds', async () => {
    const r = await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 'src-serp', account_name: 'x', credentials: { api_key_value: 'k-000000000000' } } });
    expect(r.status).toBe(201);
    expect(mockCreates).toHaveLength(1);
  });

  it('POST fails CLOSED when the source owner cannot be read', async () => {
    mockSourceReadError = { message: 'boom' };
    const r = await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 'src-serp', account_name: 'x', credentials: { api_key_value: 'k-000000000000' } } });
    expect(r.status).toBe(500);
    expect(mockCreates).toHaveLength(0);
  });

  it('PUT credentials onto an account of a tenant-owned source: 400, nothing written', async () => {
    seedTenantAccount();
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-tenant' }, body: { credentials: { api_key_value: 'k-000000000000' } } });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('PROVIDER_ACCOUNT_TENANT_SOURCE');
    expect(mockUpdates).toHaveLength(0);
  });

  it('PUT is_active: true on an account of a tenant-owned source: 400, not reactivated', async () => {
    seedTenantAccount();
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-tenant' }, body: { is_active: true } });
    expect(r.status).toBe(400);
    expect(mockUpdates).toHaveLength(0);
  });

  it('control: such an account can still be renamed / deactivated (cleanup stays possible)', async () => {
    seedTenantAccount();
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-tenant' }, body: { account_name: 'retired', is_active: false } });
    expect(r.status).toBe(200);
    expect(mockUpdates[0].patch).toEqual({ account_name: 'retired', is_active: false });
  });
});

// ── 2c. One env-name rule (same helper as the runtime resolver) ──────────────
describe('env-name validation uses the shared credentialSafety.isEnvVarName (no second definition)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8');
  it('the write guards and the client/server input module import isEnvVarName from credentialSafety and define no own rule', () => {
    for (const rel of ['backend/security/superAdminCredentialWriteGuards.ts', 'lib/security/credentialInputValidation.ts']) {
      const src = read(rel);
      expect(src).toMatch(/import \{[^}]*isEnvVarName[^}]*\} from '[./a-z]*credentialSafety'/);
      expect(src).not.toMatch(/function isEnvVarName|const isEnvVarName|\[A-Z\]\[A-Z0-9_\]\*/);
    }
  });
  it('the re-export is the very same function object', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const a = require('../../security/credentialSafety').isEnvVarName;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const b = require('../../../lib/security/credentialInputValidation').isEnvVarName;
    expect(b).toBe(a);
  });
});

// ── 3. Responses never carry credential material ────────────────────────────
describe('provider-accounts responses', () => {
  it('GET list returns no envelope, no ciphertext, no sentinel — and a shape-only needs_resave flag', async () => {
    const r = await call(providerAccountsRoute as Handler, 'GET', { query: { api_source_id: 'src-serp' } });
    expect(r.status).toBe(200);
    expectNoSentinel(r.text);
    expect(r.text).not.toContain('credentials_encrypted');
    expect(r.text).not.toMatch(/[0-9a-f]{24}:[0-9a-f]{32}:/i);
    const accts = (r.body as { accounts: Array<Record<string, any>> }).accounts;
    const byId = Object.fromEntries(accts.map((a) => [a.id, a]));
    expect(byId['acct-serp-prod'].credential_state).toEqual({ key: 'plaintext', env_reference: 'valid', oauth: 'absent', needs_resave: true });
    expect(byId['acct-serp-default'].credential_state).toEqual({ key: 'absent', env_reference: 'invalid', oauth: 'absent', needs_resave: true });
  });

  it('GET list marks an already-safe account as not needing a re-save', async () => {
    mockAccounts['acct-ok'] = { id: 'acct-ok', api_source_id: 'src-ok', account_name: 'ok', credentials_encrypted: JSON.stringify({ api_key_env_name: 'SERPAPI_KEY', api_key_value: encryptCredential('x-key') }) };
    const r = await call(providerAccountsRoute as Handler, 'GET', { query: { api_source_id: 'src-ok' } });
    expect((r.body as { accounts: Array<Record<string, any>> }).accounts[0].credential_state.needs_resave).toBe(false);
  });

  it('PUT response holds neither the new key, its ciphertext, nor the raw tokens', async () => {
    const r = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-openai' }, body: { credentials: { api_key_value: 'rotated-openai-key-0000000000' } } });
    expect(r.status).toBe(200);
    const stored = JSON.parse(String(mockUpdates[0].patch.credentials_encrypted));
    expect(r.text).not.toContain('rotated-openai-key');
    expect(r.text).not.toContain(stored.api_key_value);
    expect(r.text).not.toContain('credentials_encrypted');
    expectNoSentinel(r.text);
  });

  it('there is no GET on /api/provider-accounts/[id] (405, nothing read back)', async () => {
    const r = await call(providerAccountRoute as Handler, 'GET', { query: { id: 'acct-youtube' } });
    expect(r.status).toBe(405);
    expectNoSentinel(r.text);
  });

  it('every write requires the step-up capability (INTEGRATION_PLATFORM_OAUTH_MANAGE)', async () => {
    mockRequireCapability.mockImplementation(async (_q: unknown, res: any) => {
      res.status(401).json({ error: 'Step-up authentication required', code: 'STEP_UP_REQUIRED' });
      return { ok: false } as any;
    });
    const p = await call(providerAccountsRoute as Handler, 'POST', { body: { api_source_id: 's', account_name: 'a', credentials: { api_key_value: 'k-000000000000' } } });
    const u = await call(providerAccountRoute as Handler, 'PUT', { query: { id: 'acct-youtube' }, body: { credentials: { api_key_value: 'k-000000000000' } } });
    expect([p.status, u.status]).toEqual([401, 401]);
    expect(mockCreates).toHaveLength(0);
    expect(mockUpdates).toHaveLength(0);
    expect((mockRequireCapability.mock.calls[0][2] as { capability: string }).capability).toBe('integration.platform.oauth.manage');
  });
});

// ── 4. api-presets (H-2 / H-4 for this route) ───────────────────────────────
describe('/api/admin/intelligence/api-presets writes', () => {
  const goodPost = {
    name: 'SerpAPI Custom', base_url: 'https://serpapi.com/search', auth_type: 'query', api_key_env_name: 'SERPAPI_KEY',
    headers: { Accept: 'application/json', Authorization: 'Bearer {{API_KEY}}' }, query_params: { engine: 'google', q: '{{category}}', api_key: '{{SERPAPI_KEY}}' },
  };

  it('POST with valid references and templates succeeds after step-up', async () => {
    const r = await call(apiPresetsRoute as Handler, 'POST', { body: goodPost });
    expect(r.status).toBe(201);
    expect(mockRequireCapability).toHaveBeenCalledTimes(1);
    expect(mockCreatePreset).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['api_key_env_name holds a key', { api_key_env_name: FAKE_SERP_64 }, FAKE_SERP_64],
    ['Authorization header holds a literal bearer', { headers: { Authorization: `Bearer ${FAKE_SEARCHAPI_24}` } }, FAKE_SEARCHAPI_24],
    ['legacy _client_secret_env header holds a key', { headers: { _client_secret_env: FAKE_SEARCHAPI_24 } }, FAKE_SEARCHAPI_24],
    ['query_params api_key literal', { query_params: { api_key: FAKE_SERP_64 } }, FAKE_SERP_64],
    ['Google-shaped key under a neutral name', { query_params: { x: FAKE_YT_39 } }, FAKE_YT_39],
    ['base_url carries the key in its query string', { base_url: `https://serpapi.com/search?api_key=${FAKE_SERP_64}` }, FAKE_SERP_64],
    ['base_url carries userinfo', { base_url: 'https://user:pw0000000000@evil.example/' }, 'pw0000000000'],
  ])('POST refuses: %s (400, not echoed, nothing created)', async (_n, override, token) => {
    const r = await call(apiPresetsRoute as Handler, 'POST', { body: { ...goodPost, ...override } });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(token);
    expect(mockCreatePreset).not.toHaveBeenCalled();
  });

  it('POST without step-up creates nothing', async () => {
    mockRequireCapability.mockImplementation(async (_q: unknown, res: any) => { res.status(401).json({ code: 'STEP_UP_REQUIRED' }); return { ok: false } as any; });
    const r = await call(apiPresetsRoute as Handler, 'POST', { body: goodPost });
    expect(r.status).toBe(401);
    expect(mockCreatePreset).not.toHaveBeenCalled();
  });

  it('PUT changing base_url requires step-up; without it nothing is updated', async () => {
    mockRequireCapability.mockImplementation(async (_q: unknown, res: any) => { res.status(401).json({ code: 'STEP_UP_REQUIRED' }); return { ok: false } as any; });
    const r = await call(apiPresetsRoute as Handler, 'PUT', { body: { id: 'p-1', base_url: 'https://attacker.example/collect' } });
    expect(r.status).toBe(401);
    expect(mockUpdatePreset).not.toHaveBeenCalled();
  });

  it('PUT changing base_url with step-up succeeds; a secret in it is refused', async () => {
    const ok = await call(apiPresetsRoute as Handler, 'PUT', { body: { id: 'p-1', base_url: 'https://serpapi.com/search' } });
    expect(ok.status).toBe(200);
    expect(mockRequireCapability).toHaveBeenCalledTimes(1);
    const bad = await call(apiPresetsRoute as Handler, 'PUT', { body: { id: 'p-1', base_url: `https://serpapi.com/search?api_key=${FAKE_SERP_64}` } });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain(FAKE_SERP_64);
    expect(mockUpdatePreset).toHaveBeenCalledTimes(1);
  });

  it('PUT of name/category only, and PATCH enable/disable, need no step-up (control)', async () => {
    const u = await call(apiPresetsRoute as Handler, 'PUT', { body: { id: 'p-1', name: 'Renamed', category: 'trend' } });
    const p = await call(apiPresetsRoute as Handler, 'PATCH', { body: { id: 'p-1', is_active: false } });
    expect([u.status, p.status]).toEqual([200, 200]);
    expect(mockRequireCapability).not.toHaveBeenCalled();
    // Only the fields the service updates are forwarded.
    expect(mockUpdatePreset).toHaveBeenCalledWith('p-1', { name: 'Renamed', category: 'trend' });
  });
});

// ── 5. UI copy ───────────────────────────────────────────────────────────────
describe('Super Admin catalog UI copy (static)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../components/super-admin/tabs/ApiCatalogSection.tsx'), 'utf8');
  // Strip comments so the explanation of the old copy does not count as the copy.
  const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/gm, '');
  it('never instructs pasting a key into a reference field', () => {
    expect(code).not.toMatch(/paste the key directly/i);
    expect(code).not.toMatch(/Paste key or/);
  });
  it('never writes _client_*_env header slots from the form', () => {
    expect(code).not.toMatch(/mergedHeaders\._client_(id|secret)_env\s*=/);
    expect(code).not.toMatch(/_client_secret_env:\s*e\.target\.value/);
  });
});
