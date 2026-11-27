/**
 * Round 26 — runtime credential resolution, policy rules P1–P6 (providerCredentialResolver.ts).
 *
 *   S-12  a tenant-owned external-API row does not spend a platform env key unless Super
 *         Admin approved (whitelisted) it — not even a preset key towards the preset's own
 *         origin. A refusal resolves to undefined WITH a reason code.
 *   S-3   a provider account's `api_key_env_name` that is not an env-var NAME (a pasted
 *         secret) is never used as a process.env key and never returned; and an account's
 *         keys obey the same destination allow-list as platform env keys.
 *
 * FAILING CONTROLS (recorded in the round-26 report): at origin/main 2bc52db7a
 *   - the preset-origin tenant case resolves the platform key;
 *   - the secret-shaped env reference is looked up in process.env and echoed back as
 *     `api_key_env_name`;
 *   - a stored account key / env reference resolves for an unapproved tenant destination;
 *   - explainEnvNameResolution does not exist.
 *
 * All values are fake fixtures.
 */
import { buildExternalApiRequest } from '../../services/externalApi/execution';
import {
  createSourceEnvResolver,
  explainEnvNameResolution,
  isEnvNameResolvableForSource,
} from '../../services/externalApi/envResolutionPolicy';
import { resolveAccountCredentials, type ProviderAccount } from '../../services/providerAccountService';
import { encryptCredential } from '../../auth/credentialEncryption';

jest.mock('../../db/writeOwner', () => ({ ownedDbTable: () => ({ select: async () => ({ data: [], error: null }) }) }));

const FAKE = {
  YOUTUBE_API_KEY: 'FAKE-youtube-platform-key-r26',
  NEWS_API_KEY: 'FAKE-news-platform-key-r26',
  ZZ_R26_ACCOUNT_KEY: 'FAKE-account-env-key-r26',
};
// A secret pasted into the env-name field. It is ALSO planted as a process.env key so the
// control proves the old code would have looked it up (and returned its value).
const PASTED_SECRET = 'sk-FAKEpastedSecretValue0123456789abcdef';
const PASTED_SECRET_ENV_VALUE = 'FAKE-value-behind-pasted-secret-r26';

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of [...Object.keys(FAKE), PASTED_SECRET]) saved[k] = process.env[k];
});
beforeEach(() => {
  for (const [k, v] of Object.entries(FAKE)) process.env[k] = v;
  process.env[PASTED_SECRET] = PASTED_SECRET_ENV_VALUE;
});
afterAll(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const YT = 'https://www.googleapis.com/youtube/v3/search';
const row = (over: Record<string, unknown> = {}) => ({
  id: 'src', name: 'Row', base_url: YT, method: 'GET', auth_type: 'api_key',
  category: 'YouTube trends', is_whitelisted: null, company_id: null,
  api_key_env_name: 'YOUTUBE_API_KEY', api_key_name: null,
  headers: {}, query_params: { key: '{{YOUTUBE_API_KEY}}' }, ...over,
}) as any;
const TENANT_A = 'company-a';
const TENANT_B = 'company-b';

const account = (creds: Record<string, unknown>, id = 'acct-r26'): ProviderAccount => ({
  id, api_source_id: 'src', account_name: 'a', credentials_encrypted: JSON.stringify(creds),
  rate_limit_per_min: null, rate_limit_per_day: null, current_usage_min: 0, current_usage_day: 0,
  last_reset_at: '', priority: 1, is_active: true, created_at: '', updated_at: '',
});

describe('S-12: tenant-owned rows do not spend platform env keys without approval', () => {
  it('POSITIVE CONTROL: a platform row resolves the declared key', () => {
    const { details, missingEnv } = buildExternalApiRequest(row());
    expect(String(details.url)).toContain(FAKE.YOUTUBE_API_KEY);
    expect(missingEnv).toEqual([]);
  });

  it('a tenant-installed preset at the preset’s OWN origin no longer gets the platform key', () => {
    const { details, missingEnv } = buildExternalApiRequest(row({ company_id: TENANT_A }));
    expect(JSON.stringify(details)).not.toContain(FAKE.YOUTUBE_API_KEY);
    expect(missingEnv).toContain('YOUTUBE_API_KEY');
    expect(explainEnvNameResolution('YOUTUBE_API_KEY', row({ company_id: TENANT_A })))
      .toEqual({ allowed: false, reason: 'refused_tenant_row_not_approved' });
  });

  it('different tenant, same configuration: each unapproved tenant is refused independently', () => {
    for (const company_id of [TENANT_A, TENANT_B]) {
      expect(isEnvNameResolvableForSource('NEWS_API_KEY', row({ company_id, base_url: 'https://newsapi.org/v2/everything' }))).toBe(false);
    }
  });

  it('a tenant row Super Admin approved (is_whitelisted) resolves — the explicit approval path still works', () => {
    expect(explainEnvNameResolution('YOUTUBE_API_KEY', row({ company_id: TENANT_A, is_whitelisted: true })))
      .toEqual({ allowed: true, reason: 'allowed_tenant_row_whitelisted' });
    const { details } = buildExternalApiRequest(row({ company_id: TENANT_A, is_whitelisted: true }));
    expect(String(details.url)).toContain(FAKE.YOUTUBE_API_KEY);
  });

  it('a caller-approved (ad-hoc test) name is still refused for an unapproved tenant row', () => {
    expect(explainEnvNameResolution('YOUTUBE_API_KEY', row({ company_id: TENANT_A }), { approvedEnvNames: ['YOUTUBE_API_KEY'] }).allowed).toBe(false);
  });

  it('refusals carry reason codes; a secret-shaped "name" is never echoed in the refusal', () => {
    const refusals: unknown[] = [];
    const resolve = createSourceEnvResolver(row({ company_id: TENANT_A }), { onRefused: (r) => refusals.push(r) });
    expect(resolve('YOUTUBE_API_KEY')).toBeUndefined();
    expect(resolve(PASTED_SECRET)).toBeUndefined();
    expect(refusals).toEqual([
      { name: 'YOUTUBE_API_KEY', reason: 'refused_tenant_row_not_approved' },
      { name: null, reason: 'refused_not_an_env_var_name' },
    ]);
    expect(JSON.stringify(refusals)).not.toContain(PASTED_SECRET);
  });

  it('missing credential is distinguishable from a refused one (P6)', () => {
    delete process.env.NEWS_API_KEY;
    const refusals: unknown[] = [];
    const resolve = createSourceEnvResolver(row({ base_url: 'https://newsapi.org/v2/everything', api_key_env_name: 'NEWS_API_KEY' }), { onRefused: (r) => refusals.push(r) });
    expect(resolve('NEWS_API_KEY')).toBeUndefined(); // allowed but unset
    expect(refusals).toEqual([]);                     // → not a refusal
  });
});

describe('S-3: provider-account credentials', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warnSpy.mockRestore());

  it('a secret-shaped api_key_env_name is never looked up, never returned, never logged', () => {
    const r = resolveAccountCredentials(account({ api_key_env_name: PASTED_SECRET }));
    expect(r.api_key_value).toBeNull();                   // control: main returned PASTED_SECRET_ENV_VALUE
    expect(r.api_key_env_name).toBeNull();                // control: main echoed the secret here
    expect(r.unresolved_reason).toBe('credential_reference_invalid');
    expect(JSON.stringify(r)).not.toContain(PASTED_SECRET);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(PASTED_SECRET);
    expect(warnSpy.mock.calls.some((c) => c[0] === 'PROVIDER_ACCOUNT_ENV_REFERENCE_INVALID')).toBe(true);
  });

  it('…and the secret cannot reach the request or missingEnv through the executor', () => {
    const creds = resolveAccountCredentials(account({ api_key_env_name: PASTED_SECRET }));
    const { details, missingEnv } = buildExternalApiRequest(row({ api_key_env_name: 'YOUTUBE_API_KEY' }), { accountCredentials: creds });
    const all = JSON.stringify({ details, missingEnv });
    expect(all).not.toContain(PASTED_SECRET);
    expect(all).not.toContain(PASTED_SECRET_ENV_VALUE);
  });

  it('POSITIVE CONTROL: a valid env reference on a platform destination resolves', () => {
    const r = resolveAccountCredentials(account({ api_key_env_name: 'ZZ_R26_ACCOUNT_KEY' }), row());
    expect(r.api_key_value).toBe(FAKE.ZZ_R26_ACCOUNT_KEY);
    expect(r.unresolved_reason).toBeUndefined();
  });

  it('legacy callers without a destination keep name-only checks (compat)', () => {
    expect(resolveAccountCredentials(account({ api_key_env_name: 'ZZ_R26_ACCOUNT_KEY' })).api_key_value).toBe(FAKE.ZZ_R26_ACCOUNT_KEY);
  });

  it('an account env reference obeys the destination allow-list: unapproved tenant row → refused', () => {
    const r = resolveAccountCredentials(account({ api_key_env_name: 'ZZ_R26_ACCOUNT_KEY' }), row({ company_id: TENANT_A }));
    expect(r.api_key_value).toBeNull();
    expect(r.unresolved_reason).toBe('credential_refused');
  });

  it('a stored (encrypted) account key is withheld from an unapproved tenant destination, released to platform/approved', () => {
    const stored = encryptCredential('FAKE-stored-account-secret-r26');
    const tenant = resolveAccountCredentials(account({ api_key_value: stored }), row({ company_id: TENANT_A }));
    expect(tenant.api_key_value).toBeNull();
    expect(tenant.unresolved_reason).toBe('credential_refused');
    expect(resolveAccountCredentials(account({ api_key_value: stored }), row()).api_key_value).toBe('FAKE-stored-account-secret-r26');
    expect(resolveAccountCredentials(account({ api_key_value: stored }), row({ company_id: TENANT_A, is_whitelisted: true })).api_key_value)
      .toBe('FAKE-stored-account-secret-r26');
  });

  it('OAuth client secrets held by an account are withheld from an unapproved tenant destination too', () => {
    const r = resolveAccountCredentials(
      account({ oauth_client_id_ref: encryptCredential('FAKE-client-id'), oauth_client_secret_ref: encryptCredential('FAKE-client-secret') }),
      row({ company_id: TENANT_B }),
    );
    expect(r.oauth_client_id).toBeNull();
    expect(r.oauth_client_secret).toBeNull();
    expect(r.unresolved_reason).toBe('credential_refused');
  });

  it('an infrastructure-secret reference stays refused (SEC91-B2 unchanged) with a reason', () => {
    const r = resolveAccountCredentials(account({ api_key_env_name: 'SUPABASE_SERVICE_ROLE_KEY' }));
    expect(r.api_key_value).toBeNull();
    expect(r.unresolved_reason).toBe('credential_refused');
  });
});
