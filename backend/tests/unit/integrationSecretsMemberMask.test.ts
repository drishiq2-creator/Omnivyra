/**
 * 04 (2026-11-20) — integration secrets are visible to company ADMINS only.
 *
 * GET /api/integrations and GET /api/integrations/[id] are open to every company member and return HYDRATED
 * integrations: `config` carries the decrypted connection credentials. The list handler's comment promised
 * "Mask sensitive config fields for non-admins" and nothing masked them. These tests pin the mechanism
 * (backend/services/integrationSecretRedaction.ts) at both routes, both ways, plus the fail-closed role read.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  REDACTED_SECRET,
  canViewIntegrationSecrets,
  isSecretConfigKey,
  redactIntegrationSecrets,
  restoreRedactedSecrets,
} from '../../services/integrationSecretRedaction';

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

let mockAccess: boolean = true;
jest.mock('../../services/userContextService', () => ({
  enforceCompanyAccess: jest.fn(async ({ res }: { res: any }) => {
    if (mockAccess) return { userId: 'u1' };
    res.status(403).json({ error: 'COMPANY_ACCESS_DENIED' });
    return null;
  }),
}));

let mockRole: string | null = null;
jest.mock('../../services/rbacService', () => ({
  Role: { COMPANY_ADMIN: 'COMPANY_ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
  enforceRole: jest.fn(async () => null),
  getUserCompanyRole: jest.fn(async () => ({ role: mockRole, userId: 'u1' })),
}));

/** A HYDRATED integration as the service returns it: decrypted secrets merged into config, legacy plaintext in non_secret_config. */
const hydrated = () => ({
  id: 'int-1',
  company_id: 'co-A',
  type: 'lead_webhook',
  name: 'Site form',
  status: 'connected',
  config: { site_url: 'https://a.example', secret: 'whsec_REAL', admin_api_key: 'id:REALKEY', consumer_secret: 'CS_REAL', empty_token: '' },
  non_secret_config: { site_url: 'https://a.example', app_password: 'LEGACY_PLAINTEXT' },
});
const mockGetIntegrations = jest.fn(async () => [hydrated()]);
const mockGetIntegration = jest.fn(async () => hydrated());
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: jest.fn(() => { throw new Error('no DB in this test'); }) }));
jest.mock('../../services/integrationService', () => ({
  // R26 T-2: the routes shape every response with the REAL toPublicIntegration.
  toPublicIntegration: jest.requireActual('../../services/integrationService').toPublicIntegration,
  IntegrationValidationError: jest.requireActual('../../services/integrationService').IntegrationValidationError,
  getIntegrations: (...a: unknown[]) => (mockGetIntegrations as any)(...a),
  getIntegration: (...a: unknown[]) => (mockGetIntegration as any)(...a),
  createIntegration: jest.fn(),
  updateIntegration: jest.fn(),
  deleteIntegration: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const listHandler = require('../../../pages/api/integrations/index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const oneHandler = require('../../../pages/api/integrations/[id]').default;

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res as NextApiResponse & { statusCode: number; body: any };
}
async function callList() {
  const res = mockRes();
  await listHandler({ method: 'GET', query: { company_id: 'co-A' }, body: undefined } as unknown as NextApiRequest, res);
  return res;
}
async function callOne() {
  const res = mockRes();
  await oneHandler({ method: 'GET', query: { company_id: 'co-A', id: 'int-1' }, body: undefined } as unknown as NextApiRequest, res);
  return res;
}
const SECRET_VALUES = ['whsec_REAL', 'id:REALKEY', 'CS_REAL', 'LEGACY_PLAINTEXT'];
const leaks = (body: unknown) => SECRET_VALUES.filter((v) => JSON.stringify(body).includes(v));

afterEach(() => { mockAccess = true; mockRole = null; jest.clearAllMocks(); });

describe.each([
  ['GET /api/integrations', callList, (b: any) => b.integrations[0]],
  ['GET /api/integrations/[id]', callOne, (b: any) => b.integration],
])('%s', (_name, call, pick) => {
  it.each(['CONTENT_CREATOR', 'VIEW_ONLY', 'CONTENT_REVIEWER'])('a %s member gets NO secret value (config + non_secret_config)', async (role) => {
    mockRole = role;
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(leaks(res.body)).toEqual([]);
    const i = pick(res.body);
    expect(i.config).toMatchObject({ secret: REDACTED_SECRET, admin_api_key: REDACTED_SECRET, consumer_secret: REDACTED_SECRET });
    expect(i.non_secret_config.app_password).toBe(REDACTED_SECRET);
    expect(res.body.secrets_visible).toBe(false);
  });

  it('non-secret fields survive, and an EMPTY secret stays empty ("not configured" stays distinguishable)', async () => {
    mockRole = 'VIEW_ONLY';
    const i = pick((await call()).body);
    expect(i.config.site_url).toBe('https://a.example');
    expect(i.config.empty_token).toBe('');
  });

  it('FAIL-CLOSED: an unreadable role (null) is redacted, never shown', async () => {
    mockRole = null;
    const res = await call();
    expect(leaks(res.body)).toEqual([]);
    expect(res.body.secrets_visible).toBe(false);
  });

  // R26 T-2 (supersedes the 11-20 admin exception): secrets are write-only for EVERY role. This case used to assert
  // that admins received all four plaintext values, i.e. it defended the T-2 finding.
  it.each(['COMPANY_ADMIN', 'SUPER_ADMIN'])('R26 T-2: a %s ALSO gets no secret value (write-only), with the stored indicator', async (role) => {
    mockRole = role;
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(leaks(res.body)).toEqual([]);
    expect(res.body.secrets_visible).toBe(false);
    expect(pick(res.body).secret_fields_set).toEqual(expect.arrayContaining(['secret', 'admin_api_key', 'consumer_secret', 'app_password']));
  });

  it('cross-tenant: a non-member is refused before any integration is read', async () => {
    mockAccess = false;
    mockRole = 'COMPANY_ADMIN';
    const res = await call();
    expect(res.statusCode).toBe(403);
    expect(leaks(res.body)).toEqual([]);
    expect(mockGetIntegrations).not.toHaveBeenCalled();
    expect(mockGetIntegration).not.toHaveBeenCalled();
  });
});

describe('integrationSecretRedaction (pure)', () => {
  it('every key the credential store treats as secret is redacted (no gap between the two lists)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SECRET_CONFIG_KEYS } = require('../../services/integrationCredentialService');
    const keys = [...(SECRET_CONFIG_KEYS as Set<string>)];
    expect(keys.length).toBeGreaterThan(5); // non-vacuity
    expect(keys.filter((k) => !isSecretConfigKey(k))).toEqual([]);
  });

  it('the NAME backstop catches secret-named keys the named set never listed; plain fields are not caught', () => {
    for (const k of ['consumer_secret', 'token', 'private_key', 'db_password', 'oauthCredential']) expect(isSecretConfigKey(k)).toBe(true);
    for (const k of ['site_url', 'endpoint_url', 'shop_domain', 'name', 'username']) expect(isSecretConfigKey(k)).toBe(false);
  });

  it.each([
    'connection_string', 'connectionString', 'dsn', 'database_dsn', 'auth_header', 'basic_auth', 'authorization',
    'signature', 'webhook_signature', 'sas', 'sas_url', 'pem', 'client_pem', 'cert', 'client_certificate', 'salt', 'hash_salt',
  ])('7c NB1: %s is treated as secret', (k) => {
    expect(isSecretConfigKey(k)).toBe(true);
    // A DSN-shaped value assembled at runtime: no credential-URL literal in source (public repo, gitleaks).
    const dsnLike = ['postgres', '://', 'fixture-user', ':', 'fixture-pass', '@', 'fixture-host/db'].join('');
    const out = (redactIntegrationSecrets({ config: { [k]: dsnLike } }).config as any)[k];
    expect(out).toBe(REDACTED_SECRET);
    expect(out).not.toContain('fixture-pass');
  });

  it.each(['author_email', 'author_name', 'author', 'authors'])('CONTROL: %s (contains "auth") is a display field and is NOT masked', (k) => {
    expect(isSecretConfigKey(k)).toBe(false);
  });

  it('only COMPANY_ADMIN / SUPER_ADMIN may view; anything else, and null, may not', () => {
    expect(canViewIntegrationSecrets('COMPANY_ADMIN')).toBe(true);
    expect(canViewIntegrationSecrets('SUPER_ADMIN')).toBe(true);
    for (const r of ['ADMIN_X', 'CONTENT_CREATOR', 'VIEW_ONLY', '', null, undefined]) expect(canViewIntegrationSecrets(r as any)).toBe(false);
  });

  it('redaction does not mutate the input', () => {
    const src = hydrated();
    redactIntegrationSecrets(src);
    expect(src.config.secret).toBe('whsec_REAL');
  });

  it('restoreRedactedSecrets: a placeholder means "unchanged" → the stored value; no stored value → dropped; a new value passes', () => {
    expect(restoreRedactedSecrets({ secret: REDACTED_SECRET, site_url: 'x' }, { secret: 'whsec_REAL' })).toEqual({ secret: 'whsec_REAL', site_url: 'x' });
    expect(restoreRedactedSecrets({ secret: REDACTED_SECRET }, {})).toEqual({});
    expect(restoreRedactedSecrets({ secret: REDACTED_SECRET }, { secret: REDACTED_SECRET })).toEqual({});
    expect(restoreRedactedSecrets({ secret: 'whsec_NEW' }, { secret: 'whsec_REAL' })).toEqual({ secret: 'whsec_NEW' });
  });
});
