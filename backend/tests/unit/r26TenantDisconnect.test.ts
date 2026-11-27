/**
 * R26 T-4 — disconnect deletes the stored credentials, attempts provider revocation, and audits the outcome.
 *
 * At 2bc52db7a:
 *   - deleteIntegration removed only the company_integrations row; every integration_credentials ciphertext stayed;
 *   - POST /api/social-accounts/disconnect and DELETE /api/community-ai/connectors/[platform] set is_active=false and
 *     kept access_token / refresh_token; nothing called a provider revoke endpoint; nothing was audited.
 *
 * The fake DB below records every operation per table, so "no credential left" is asserted on what was actually
 * issued, not on a return value. Failing controls at 2bc52db7a: no integration_credentials delete, no token wipe, no
 * revoke fetch, no audit row.
 */
import type { NextApiRequest, NextApiResponse } from 'next';

type Op = { table: string; op: string; payload?: any; filters: Array<[string, string, unknown]> };
const ops: Op[] = [];
let connectionOwner = 'co-A';
let otherIntegrationsOnConnection: unknown[] = [];
let wipeError: { message: string } | null = null;
let updateMatchesNothing = false;

/**
 * SCHEMA-FAITHFUL social_accounts (integration review H-1): the PRODUCTION column list (prod schema dump
 * closure-r6/e2e-refresh/prod-public-schema.sql, CT-verified 2026-11-27 — there is NO `status` column), the
 * access_token NOT NULL constraint and social_accounts_facebook_token_chk. An update naming any other column is
 * rejected like PostgREST does (42703) and changes nothing.
 */
const PROD_SOCIAL_COLUMNS = new Set(('id user_id platform platform_user_id account_name username access_token refresh_token is_active ' +
  'created_at updated_at profile_picture_url follower_count following_count token_expires_at last_sync_at company_id ' +
  'phone_number_id waba_id display_phone business_account_id messaging_tier quality_rating meta_connection_id ' +
  'page_access_token ig_user_token threads_token linked_page_id linked_ig_business_id is_system_user connection_state ' +
  'last_live_check_at last_live_check_status last_provider_error refresh_status last_refresh_attempt_at last_refresh_error ' +
  'refresh_retry_count last_successful_refresh_at refresh_lock_owner refresh_lock_acquired_at granted_scopes ' +
  'granted_scopes_recorded_at scope_version_hash permissions').split(' '));
let socialStore: Array<Record<string, any>> = [];
const socialRow = (over: Record<string, any>): Record<string, any> => ({
  id: 'sa-1', user_id: 'user-1', platform: 'facebook', company_id: 'co-A', is_active: true, is_system_user: false,
  access_token: 'enc:user-token', refresh_token: 'enc:refresh', page_access_token: 'enc:page-token',
  ig_user_token: 'enc:ig-token', threads_token: 'enc:threads-token', token_expires_at: '2027-01-01T00:00:00Z',
  linked_page_id: 'page-1', linked_ig_business_id: 'ig-1', platform_user_id: 'pu-1', connection_state: 'CONNECTED',
  ...over,
});
function socialMatches(r: Record<string, any>, filters: Array<[string, string, unknown]>): boolean {
  return filters.every(([k, c, v]) => (k === 'eq' ? r[c] === v : k === 'in' ? (v as unknown[]).includes(r[c]) : true));
}
function socialUpdate(payload: Record<string, any>, filters: Array<[string, string, unknown]>) {
  if (wipeError) return { data: null, error: wipeError };
  if (updateMatchesNothing) return { data: [], error: null };
  const unknown = Object.keys(payload).filter((c) => !PROD_SOCIAL_COLUMNS.has(c));
  if (unknown.length) return { data: null, error: { code: '42703', message: `column "${unknown[0]}" of relation "social_accounts" does not exist` } };
  if ('access_token' in payload && payload.access_token === null) return { data: null, error: { code: '23502', message: 'null value in column "access_token" violates not-null constraint' } };
  const hits = socialStore.filter((r) => socialMatches(r, filters));
  const next = hits.map((r) => ({ ...r, ...payload }));
  const fbBad = next.find((r) => r.platform === 'facebook' && r.is_system_user !== true && r.is_active !== false && r.page_access_token == null);
  if (fbBad) return { data: null, error: { code: '23514', message: 'violates check constraint "social_accounts_facebook_token_chk"' } };
  hits.forEach((r, i) => Object.assign(r, next[i]));
  return { data: hits.map((r) => ({ ...r })), error: null };
}

function fakeTable(table: string) {
  const op: Op = { table, op: 'select', filters: [] };
  ops.push(op);
  const result = () => {
    if (table === 'company_integrations' && op.op === 'select') {
      if (op.filters.some(([k]) => k === 'neq')) return { data: otherIntegrationsOnConnection, error: null };
      return { data: { id: 'int-1', type: 'wordpress', website_connection_id: 'conn-1' }, error: null };
    }
    if (table === 'website_connections' && op.op === 'select') {
      return { data: { id: 'conn-1', websites: { company_id: connectionOwner } }, error: null };
    }
    if (table === 'integration_credentials' && op.op === 'delete') return { data: [{ id: 'c1' }, { id: 'c2' }], error: null };
    if (table === 'social_accounts' && op.op === 'update') return socialUpdate(op.payload, op.filters);
    if (table === 'social_accounts' && op.op === 'select') return { data: socialStore.filter((r) => socialMatches(r, op.filters)), error: null };
    return { data: null, error: null };
  };
  const chain: any = {
    select: () => chain,
    eq: (k: string, v: unknown) => { op.filters.push(['eq', k, v]); return chain; },
    neq: (k: string, v: unknown) => { op.filters.push(['neq', k, v]); return chain; },
    in: (k: string, v: unknown) => { op.filters.push(['in', k, v]); return chain; },
    not: () => chain, limit: () => chain, order: () => chain,
    update: (p: any) => { op.op = 'update'; op.payload = p; return chain; },
    delete: () => { op.op = 'delete'; return chain; },
    insert: (p: any) => { op.op = 'insert'; op.payload = p; return chain; },
    maybeSingle: async () => {
      const r: any = result();
      return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r;
    },
    single: async () => result(),
    then: (ok: any, ko: any) => Promise.resolve(result()).then(ok, ko),
  };
  return chain;
}

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => fakeTable(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => fakeTable(t) } }));
jest.mock('../../services/websiteService', () => ({ createWebsiteConnection: jest.fn(), resolveWebsiteForCompany: jest.fn() }));
jest.mock('../../services/cms/registry', () => ({ getCmsAdapter: jest.fn(), isCmsProvider: () => true }));
jest.mock('../../services/cms/cmsConnectionNormalizationService', () => ({ ensureCanonicalConnectionForIntegration: jest.fn() }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

const ACCESS = 'ya29.ACCESS_fixture';
const REFRESH = '1//REFRESH_fixture';
jest.mock('../../auth/tokenStore', () => ({
  getToken: jest.fn(async () => ({ access_token: ACCESS, refresh_token: REFRESH })),
  deactivateSocialAccount: jest.fn(async () => undefined),
}));

let mockUser: { id: string } | null = { id: 'user-1' };
jest.mock('../../services/supabaseAuthService', () => ({
  getSupabaseUserFromRequest: jest.fn(async () => ({ user: mockUser, error: mockUser ? null : 'no session' })),
}));

let mockConnectorAccess: { userId: string; role: string } | null = { userId: 'admin-1', role: 'COMPANY_ADMIN' };
jest.mock('../../../pages/api/community-ai/connectors/utils', () => ({
  requireManageConnectors: jest.fn(async (_req: any, res: any) => {
    if (mockConnectorAccess) return mockConnectorAccess;
    res.status(403).json({ error: 'COMPANY_ACCESS_DENIED' });
    return null;
  }),
}));
const mockRevokeMetadata = jest.fn(async () => null);
jest.mock('../../services/platformTokenService', () => ({
  revokeToken: (...a: unknown[]) => (mockRevokeMetadata as any)(...a),
  getConnectorConnectedByUserId: jest.fn(async () => 'owner-user'),
}));

const fetchMock = jest.fn();
const ORIGINAL_FETCH = global.fetch;
beforeAll(() => { (global as any).fetch = fetchMock; });
afterAll(() => { (global as any).fetch = ORIGINAL_FETCH; });

import { deleteIntegration } from '../../services/integrationService';
import { CrossTenantCredentialError } from '../../services/integrationCredentialService';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const socialDisconnect = require('../../../pages/api/social-accounts/disconnect').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const connectorDisconnect = require('../../../pages/api/community-ai/connectors/[platform]').default;

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res as NextApiResponse & { statusCode: number; body: any };
}
const opsOn = (table: string, op: string) => ops.filter((o) => o.table === table && o.op === op);

beforeEach(() => {
  ops.length = 0;
  connectionOwner = 'co-A';
  otherIntegrationsOnConnection = [];
  wipeError = null;
  mockUser = { id: 'user-1' };
  mockConnectorAccess = { userId: 'admin-1', role: 'COMPANY_ADMIN' };
  socialStore = [];
  updateMatchesNothing = false;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  mockRevokeMetadata.mockClear();
});

describe('DELETE integration: credentials are deleted, connection retired, audited', () => {
  it('issues a delete on integration_credentials for the connection, retires the connection, then deletes the row', async () => {
    const result = await deleteIntegration('int-1', 'co-A', { actorUserId: 'u1' });
    const credDeletes = opsOn('integration_credentials', 'delete');
    expect(credDeletes).toHaveLength(1);
    expect(credDeletes[0].filters).toContainEqual(['eq', 'connection_id', 'conn-1']);
    const retire = opsOn('website_connections', 'update');
    expect(retire).toHaveLength(1);
    expect(retire[0].payload).toMatchObject({ status: 'deleted', encrypted_credentials: {} });
    expect(opsOn('company_integrations', 'delete')).toHaveLength(1);
    // the credential delete happens BEFORE the row delete (a failure leaves the row for a retry)
    expect(ops.indexOf(credDeletes[0])).toBeLessThan(ops.indexOf(opsOn('company_integrations', 'delete')[0]));
    expect(result).toEqual({ deleted: true, credentials_deleted: 2, connection_retired: true, provider_revocation: 'not_supported' });
    const audit = opsOn('audit_events', 'insert');
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ company_id: 'co-A', actor_user_id: 'u1', action: 'tenant_credential.integration_disconnected' });
  });

  it('different tenant: a connection owned by another company deletes NOTHING (CrossTenantCredentialError)', async () => {
    connectionOwner = 'co-B';
    await expect(deleteIntegration('int-1', 'co-A')).rejects.toBeInstanceOf(CrossTenantCredentialError);
    expect(opsOn('integration_credentials', 'delete')).toHaveLength(0);
    expect(opsOn('company_integrations', 'delete')).toHaveLength(0);
  });

  it('a connection another integration still uses keeps its credentials, and the audit says so', async () => {
    otherIntegrationsOnConnection = [{ id: 'int-2' }];
    const result = await deleteIntegration('int-1', 'co-A');
    expect(opsOn('integration_credentials', 'delete')).toHaveLength(0);
    expect(result.credentials_deleted).toBe(0);
    expect(opsOn('audit_events', 'insert')[0].payload.metadata.shared_connection_credentials_retained).toBe(true);
  });
});

async function postSocialDisconnect(platform: string) {
  const res = mockRes();
  await socialDisconnect({ method: 'POST', body: { platform }, query: {}, headers: {} } as unknown as NextApiRequest, res);
  return res;
}
const TOKEN_COLS = ['access_token', 'refresh_token', 'page_access_token', 'ig_user_token', 'threads_token'];
/** Every token column of the STORED row (the schema-faithful store, not the payload) is empty. */
const storedTokensGone = (id: string) => {
  const r = socialStore.find((x) => x.id === id)!;
  return TOKEN_COLS.every((c) => (c === 'access_token' ? r[c] === '' : r[c] === null)) && r.is_active === false;
};

describe('POST /api/social-accounts/disconnect (schema-faithful social_accounts)', () => {
  it('H-1: every Production token column (incl. page / IG / Threads) is cleared in the STORED row, proven, then 200', async () => {
    socialStore = [socialRow({ id: 'sa-1', platform: 'facebook' })];
    const res = await postSocialDisconnect('facebook');
    expect(res.statusCode).toBe(200);
    expect(storedTokensGone('sa-1')).toBe(true);
    expect(socialStore[0].connection_state).toBe('DISCONNECTED');
    expect(res.body.credentials_deleted).toBe(true);
    // never a column Production does not have
    for (const u of opsOn('social_accounts', 'update')) for (const k of Object.keys(u.payload)) expect(PROD_SOCIAL_COLUMNS.has(k)).toBe(true);
    const audit = opsOn('audit_events', 'insert');
    expect(audit).toHaveLength(1);
    expect(audit[0].payload.metadata).toMatchObject({ credentials_deleted: true, provider_revocation: 'revoked' });
  });

  it('Meta revoke: token in the header, never the URL; nothing secret in the response or audit', async () => {
    socialStore = [socialRow({ id: 'sa-1', platform: 'facebook' })];
    const res = await postSocialDisconnect('facebook');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v22.0/me/permissions');
    expect(String(url)).not.toContain(ACCESS);
    expect(init.method).toBe('DELETE');
    expect(JSON.stringify(res.body) + JSON.stringify(opsOn('audit_events', 'insert'))).not.toContain(ACCESS);
  });

  it('H-1: an UNPROVEN wipe (the update changed no row) is 500 CREDENTIALS_NOT_DELETED, credentials_deleted:false, audited critical', async () => {
    socialStore = [socialRow({ id: 'sa-1', platform: 'facebook' })];
    updateMatchesNothing = true; // the row is gone by the time of the wipe: the update changes 0 rows
    const res = await postSocialDisconnect('facebook');
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'CREDENTIALS_NOT_DELETED', credentials_deleted: false });
    expect(res.body.failures[0].reason).toBe('row_not_updated');
    const audit = opsOn('audit_events', 'insert')[0].payload;
    expect(audit.severity).toBe('critical');
    expect(audit.metadata).toMatchObject({ credentials_deleted: false, credentials_reason: 'row_not_updated' });
  });

  it('a rejected update is reported, never "deleted"', async () => {
    socialStore = [socialRow({ id: 'sa-1', platform: 'facebook' })];
    wipeError = { message: 'boom' };
    const res = await postSocialDisconnect('facebook');
    expect(res.statusCode).toBe(500);
    expect(res.body.credentials_deleted).toBe(false);
    expect(socialStore[0].page_access_token).toBe('enc:page-token');
  });

  it('REVOKE FAILURE is recorded explicitly (response + warning audit row) and the tokens are still wiped', async () => {
    socialStore = [socialRow({ id: 'sa-2', platform: 'youtube', page_access_token: null, linked_page_id: null })];
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const res = await postSocialDisconnect('youtube');
    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(res.body.provider_revocation).toEqual([{ platform: 'youtube', status: 'failed' }]);
    const audit = opsOn('audit_events', 'insert')[0].payload;
    expect(audit.severity).toBe('warning');
    expect(audit.metadata).toMatchObject({ provider_revocation: 'failed', provider_revocation_detail: 'http_503' });
    expect(storedTokensGone('sa-2')).toBe(true);
  });

  it('a provider without a token-only revoke API is reported "unsupported" (never silently "revoked")', async () => {
    socialStore = [socialRow({ id: 'sa-3', platform: 'linkedin', page_access_token: null })];
    const res = await postSocialDisconnect('linkedin');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.body.provider_revocation).toEqual([{ platform: 'linkedin', status: 'unsupported' }]);
    expect(storedTokensGone('sa-3')).toBe(true);
  });

  it('M-4: a sibling ACTIVE row on the same Meta grant (same user) → no provider revoke, recorded skipped_shared_grant; the sibling keeps working', async () => {
    socialStore = [
      socialRow({ id: 'sa-1', platform: 'facebook' }),
      socialRow({ id: 'sa-ig', platform: 'instagram' }),
    ];
    const res = await postSocialDisconnect('facebook');
    expect(res.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.body.provider_revocation).toEqual([{ platform: 'facebook', status: 'skipped_shared_grant' }]);
    expect(storedTokensGone('sa-1')).toBe(true);
    const sibling = socialStore.find((r) => r.id === 'sa-ig')!;
    expect(sibling.is_active).toBe(true);
    expect(sibling.ig_user_token).toBe('enc:ig-token');
    expect(opsOn('audit_events', 'insert')[0].payload.metadata).toMatchObject({ provider_revocation: 'skipped_shared_grant' });
  });

  it("M-4 CONTROL: another user's Meta row is not a sibling → the grant is revoked", async () => {
    socialStore = [
      socialRow({ id: 'sa-1', platform: 'facebook' }),
      socialRow({ id: 'sa-other', platform: 'instagram', user_id: 'someone-else' }),
    ];
    const res = await postSocialDisconnect('facebook');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.body.provider_revocation).toEqual([{ platform: 'facebook', status: 'revoked' }]);
  });

  it('unauthorised: no session -> 401, nothing read, revoked or written', async () => {
    mockUser = null;
    socialStore = [socialRow({})];
    const res = await postSocialDisconnect('facebook');
    expect(res.statusCode).toBe(401);
    expect(ops).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function deleteConnector(platform: string) {
  const res = mockRes();
  await connectorDisconnect({ method: 'DELETE', query: { platform, tenant_id: 'co-A', organization_id: 'co-A' }, headers: {} } as unknown as NextApiRequest, res);
  return res;
}

describe('DELETE /api/community-ai/connectors/[platform] (schema-faithful social_accounts)', () => {
  it("an admin disconnect wipes the CONNECTOR OWNER's tokens in this company (proven), revokes, then deletes the metadata", async () => {
    socialStore = [socialRow({ id: 'sa-o', user_id: 'owner-user', platform: 'facebook' })];
    const res = await deleteConnector('facebook');
    expect(res.statusCode).toBe(200);
    const read = opsOn('social_accounts', 'select')[0];
    expect(read.filters).toContainEqual(['eq', 'user_id', 'owner-user']);
    expect(read.filters).toContainEqual(['eq', 'company_id', 'co-A']);
    expect(storedTokensGone('sa-o')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRevokeMetadata).toHaveBeenCalledWith('co-A', 'co-A', 'facebook');
    expect(res.body).toMatchObject({ credentials_deleted: true, provider_revocation: [{ platform: 'facebook', status: 'revoked' }] });
  });

  it('different tenant / no connector access: refused, nothing wiped or revoked', async () => {
    mockConnectorAccess = null;
    socialStore = [socialRow({ id: 'sa-o', user_id: 'owner-user' })];
    const res = await deleteConnector('facebook');
    expect(res.statusCode).toBe(403);
    expect(opsOn('social_accounts', 'update')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRevokeMetadata).not.toHaveBeenCalled();
  });

  it('an unproven wipe keeps the connector metadata (retryable) and answers 500 credentials_deleted:false', async () => {
    socialStore = [socialRow({ id: 'sa-o', user_id: 'owner-user' })];
    wipeError = { message: 'boom' };
    const res = await deleteConnector('facebook');
    expect(res.statusCode).toBe(500);
    expect(res.body.credentials_deleted).toBe(false);
    expect(mockRevokeMetadata).not.toHaveBeenCalled();
  });
});
