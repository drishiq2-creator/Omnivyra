/**
 * @jest-environment jsdom
 *
 * b3 2026-11-19 (a9's server change): /api/auth/facebook and /api/auth/instagram REQUIRE a company and
 * answer a raw 400 "Choose a company first" without one. handleConnect is a full-page navigation, so with
 * no company selected it must NOT navigate there; it shows the same sentence instead.
 */
import { renderHook, act } from '@testing-library/react';

let selectedCompanyId: string | null = null;
jest.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: jest.fn(), replace: jest.fn(), isReady: true, pathname: '/' }) }));
jest.mock('../../../components/CompanyContext', () => ({
  useCompanyContext: () => ({ selectedCompanyId, user: { userId: 'u1' }, userRole: 'COMPANY_ADMIN', isLoading: false }),
}));
jest.mock('../../../lib/apiFetch', () => ({ apiFetch: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ accounts: [] }) })) }));
jest.mock('../../../lib/supabaseBrowser', () => ({ getSupabaseBrowser: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));

import { useSocialPlatforms, CHOOSE_COMPANY_FIRST, META_AUTH_PATH } from '../../../hooks/useSocialPlatforms';

let assigned: string[] = [];
beforeAll(() => {
  // Capture full-page navigations instead of performing them.
  Object.defineProperty(window, 'location', { configurable: true, value: { set href(v: string) { assigned.push(v); }, get href() { return 'http://localhost/'; } } });
});
beforeEach(() => { assigned = []; });

const platform = (key: string, auth_path: string) => ({ platform_key: key, platform_label: key, auth_path, oauth_configured: true, connected: false }) as never;

describe('connect without a selected company', () => {
  it.each([
    ['facebook', '/api/auth/facebook'],
    ['instagram', '/api/auth/instagram'],
    ['threads', '/api/auth/instagram'],
  ])('%s: no navigation, the plain sentence instead', async (key, path) => {
    selectedCompanyId = null;
    const { result } = renderHook(() => useSocialPlatforms());
    await act(async () => { await result.current.handleConnect(platform(key, path)); });
    expect(assigned).toEqual([]);
    expect(result.current.notice).toEqual({ type: 'error', message: CHOOSE_COMPANY_FIRST });
  });

  it('a non-Meta legacy path still navigates without a company (unchanged)', async () => {
    selectedCompanyId = null;
    const { result } = renderHook(() => useSocialPlatforms());
    await act(async () => { await result.current.handleConnect(platform('pinterest', '/api/auth/pinterest')); });
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatch(/^\/api\/auth\/pinterest\?/);
  });

  it('control: WITH a company, Facebook goes to the connector route as before', async () => {
    selectedCompanyId = 'c1';
    const { result } = renderHook(() => useSocialPlatforms());
    await act(async () => { await result.current.handleConnect(platform('facebook', '/api/auth/facebook')); });
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatch(/^\/api\/community-ai\/connectors\/facebook\/auth\?/);
  });
});

describe('pinned to the LIVE producer (7c)', () => {
  // auth_path comes from the server catalog; a fixture copy would share the assumption. Read the real one.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SUPPORTED_PLATFORMS } = require('../../../pages/api/social-accounts/status');
  const authPathOf = (key: string) => (SUPPORTED_PLATFORMS as Array<{ key: string; authPath: string | null }>).find((p) => p.key === key)?.authPath ?? null;
  it.each(['facebook', 'instagram', 'threads'])('the catalog authPath for %s is one the guard recognises', (key) => {
    const path = authPathOf(key);
    expect(path).not.toBeNull();
    expect(META_AUTH_PATH.test(path as string)).toBe(true);
  });
  it('control: a non-Meta catalog path is not matched', () => {
    expect(META_AUTH_PATH.test(authPathOf('pinterest') as string)).toBe(false);
  });
});
