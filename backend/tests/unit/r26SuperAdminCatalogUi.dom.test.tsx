/**
 * @jest-environment jsdom
 *
 * Round 26 (Agent C) — Super Admin catalog UI credential-input validation.
 *
 *  - A key typed into the account "API Key Env Var Name" field is refused in the browser:
 *    no request is sent, and the error never repeats the value.
 *  - In edit mode, "Remove the stored env var reference" sends `api_key_env_name: null`, the
 *    only way to clear a reference that holds a pasted key.
 *  - An account whose stored credential is unsafe shows a "Needs re-save" badge (from the
 *    shape-only `credential_state`).
 *  - The catalog provider form refuses a key in its env-var NAME field and strips the legacy
 *    `_client_*_env` header slots.
 *
 * Every credential value is a synthetic placeholder.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const FAKE_KEY = 'Zq8xR2vT9kLm3NpW7sYb4Hc1PlaceholderOnly00';

const fetchWithAuth = jest.fn();
const runStepUpFlowIfNeeded = jest.fn();

jest.mock('../../../components/community-ai/fetchWithAuth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
jest.mock('@/lib/security/superAdminStepUp', () => ({
  runStepUpFlowIfNeeded: (...args: unknown[]) => runStepUpFlowIfNeeded(...args),
  describeStepUpOutcome: () => 'step-up failed',
}));
jest.mock('@/lib/security/superAdminAuthFailure', () => ({ describeAuthFailure: () => 'auth failed' }));
jest.mock('@/utils/getAuthToken', () => ({ getAuthToken: async () => 'token' }));
jest.mock('@/lib/utils/safeFetchJson', () => ({
  parseJsonResponse: async (res: { ok: boolean; json: () => Promise<unknown> }) =>
    res.ok ? { ok: true, data: await res.json() } : { ok: false },
}));
jest.mock('@/pages/super-admin.types', () => ({
  KNOWN_APIS: { trend: [{ key: 'searchapi', name: 'SearchAPI', env_var: 'SEARCHAPI_KEY', base_url: 'https://www.searchapi.io/api/v1/search', auth_type: 'query' }] },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ApiCatalogSection = require('../../../components/super-admin/tabs/ApiCatalogSection').default;

const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body });
const SOURCE = {
  id: 'src-1', name: 'SearchAPI', auth_type: 'query', base_url: 'https://www.searchapi.io/api/v1/search', is_active: true,
  api_key_env_name: '__REDACTED_INVALID_ENV_VAR_NAME__',
  headers: { _client_id_env: 'SEARCHAPI_KEY', Accept: 'application/json' }, query_params: { engine: 'google' },
};
const ACCOUNT = {
  id: 'acct-1', api_source_id: 'src-1', account_name: 'default', priority: 1, is_active: true,
  rate_limit_per_min: null, rate_limit_per_day: null, current_usage_min: 0, current_usage_day: 0,
  credential_state: { key: 'encrypted', env_reference: 'invalid', oauth: 'absent', needs_resave: true },
};

function mutations() {
  return fetchWithAuth.mock.calls.filter(([, init]) => init && init.method && init.method !== 'GET');
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/external-apis')) return ok({ apis: [SOURCE] });
    if (String(url).includes('/api/provider-accounts?')) return ok({ accounts: [ACCOUNT] });
    return ok({ account: { id: 'acct-1' } });
  });
  runStepUpFlowIfNeeded.mockImplementation(async (initial: unknown) => ({ kind: 'success', response: initial }));
});

async function expandProvider() {
  render(<ApiCatalogSection categoryKey="trend" />);
  // Wait for the catalog row to load (the known-API list renders before it does).
  fireEvent.click(await screen.findByText('Update'));
  await screen.findByText('default');
}

describe('account modal', () => {
  it('shows "Needs re-save" for an account whose stored credential is unsafe', async () => {
    await expandProvider();
    expect(screen.getByText('Needs re-save')).toBeTruthy();
  });

  it('refuses a key typed into the env-var NAME field: no request, value not repeated', async () => {
    await expandProvider();
    fireEvent.click(screen.getByTitle('Edit account'));
    await screen.findByText(/Edit Account — Credentials/);
    fireEvent.change(screen.getByPlaceholderText('e.g. YOUTUBE_API_KEY_2'), { target: { value: FAKE_KEY } });
    fireEvent.click(screen.getByText('Save Changes', { selector: 'button' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('API Key Value');
    expect(screen.getByRole('alert').textContent).not.toContain(FAKE_KEY);
    expect(mutations()).toHaveLength(0);
  });

  it('"Remove the stored env var reference" sends api_key_env_name: null', async () => {
    await expandProvider();
    fireEvent.click(screen.getByTitle('Edit account'));
    await screen.findByText(/Edit Account — Credentials/);
    fireEvent.click(screen.getByLabelText('Remove the stored env var reference'));
    fireEvent.click(screen.getByText('Save Changes', { selector: 'button' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    const [url, init] = mutations()[0];
    expect(url).toBe('/api/provider-accounts/acct-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body).credentials).toEqual({ api_key_env_name: null });
  });

  it('a key in "API Key Value" goes only in the PUT body (never the URL)', async () => {
    await expandProvider();
    fireEvent.click(screen.getByTitle('Edit account'));
    await screen.findByText(/Edit Account — Credentials/);
    fireEvent.change(screen.getByPlaceholderText('Leave blank to keep the current key'), { target: { value: FAKE_KEY } });
    fireEvent.click(screen.getByText('Save Changes', { selector: 'button' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    const [url, init] = mutations()[0];
    expect(String(url)).not.toContain(FAKE_KEY);
    expect(JSON.parse(init.body).credentials).toEqual({ api_key_value: FAKE_KEY });
  });
});

describe('catalog provider form', () => {
  it('does not pre-fill a redacted/invalid stored reference and refuses a key typed there', async () => {
    await expandProvider();
    const input = screen.getByPlaceholderText('SEARCHAPI_KEY') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: FAKE_KEY } });
    fireEvent.click(screen.getByText('Save', { selector: 'button' }));
    await waitFor(() => expect(screen.getAllByText(/must be the NAME of an environment variable/).length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain(FAKE_KEY); // the value stays only in the input
    expect(mutations()).toHaveLength(0);
  });

  it('a valid save strips the legacy _client_*_env header slots', async () => {
    await expandProvider();
    fireEvent.change(screen.getByPlaceholderText('SEARCHAPI_KEY'), { target: { value: 'SEARCHAPI_KEY' } });
    fireEvent.click(screen.getByText('Save', { selector: 'button' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    const body = JSON.parse(mutations()[0][1].body);
    expect(body.api_key_env_name).toBe('SEARCHAPI_KEY');
    expect(body.headers).toEqual({ Accept: 'application/json' });
  });
});
