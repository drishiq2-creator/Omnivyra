/**
 * @jest-environment jsdom
 *
 * Client side of the admin-only website pages (owner ruling 2026-11-20, via b3):
 *  - /leads: the Forms tab follows the SERVER's answer; a form delete that fails is reported, never shown as done
 *    (it used to be swallowed and the dialog closed as if it had worked);
 *  - /website-setup: "Connect Google Analytics" POSTs (the API is POST-only; the old GET link was a 405);
 *  - which pages are wrapped: the three website pages always, /integrations ONLY for focus=website.
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

let mockCompanyId = 'co-A';
jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: mockCompanyId, userRole: 'COMPANY_ADMIN' }) }));
jest.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: jest.fn(), replace: jest.fn(), isReady: true }) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children }: any) => <a href={href}>{children}</a> }));
jest.mock('../../../lib/analytics/activationEvents', () => ({ trackActivationEvent: jest.fn() }));
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({ fetchWithAuth: (...a: unknown[]) => (global as any).fetch(...a) }));

import { useLeadsPage } from '../../../hooks/useLeadsPage';
import { startGoogleAnalyticsConnect, GA_CONNECT_FAILED_MESSAGE } from '../../../lib/analytics/startGoogleAnalyticsConnect';
import { COMPANY_ADMIN_REQUIRED, COMPANY_ADMIN_REQUIRED_MESSAGE } from '../../../shared/auth/companyAdminRequired';

const reply = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body });
type Route = (url: string, init?: { method?: string }) => Promise<unknown> | undefined;
function stubFetch(over: Route = () => undefined, access: () => Promise<unknown> = () => reply(200, { admin: true })) {
  (global as any).fetch = jest.fn((url: string, init?: { method?: string }) => {
    const o = over(url, init);
    if (o) return o;
    if (url.startsWith('/api/company-admin/access')) return access();
    if (url.startsWith('/api/leads')) return reply(200, { leads: [] });
    if (url.startsWith('/api/forms')) return reply(200, { forms: [] });
    if (url.startsWith('/api/integrations')) return reply(200, { integrations: [] });
    return reply(200, {});
  });
}
afterEach(() => { delete (global as any).fetch; mockCompanyId = 'co-A'; });

describe('/leads forms tab follows the server', () => {
  it('CONTROL: admin → formsAccess "admin"', async () => {
    stubFetch();
    const { result } = renderHook(() => useLeadsPage());
    await waitFor(() => expect(result.current.formsAccess).toBe('admin'));
  });
  it('member (403 COMPANY_ADMIN_REQUIRED) → "not_admin"', async () => {
    stubFetch(undefined, () => reply(403, { error: 'FORBIDDEN_ROLE', code: COMPANY_ADMIN_REQUIRED }));
    const { result } = renderHook(() => useLeadsPage());
    await waitFor(() => expect(result.current.formsAccess).toBe('not_admin'));
  });
  it('an unreadable check → "unavailable", never "not_admin"', async () => {
    stubFetch(undefined, () => reply(500, {}));
    const { result } = renderHook(() => useLeadsPage());
    await waitFor(() => expect(result.current.formsAccess).toBe('unavailable'));
  });
});

describe('/leads form delete is honest', () => {
  async function deleteWith(answer: () => Promise<unknown>) {
    stubFetch((url, init) => (init?.method === 'DELETE' ? answer() : undefined));
    const { result } = renderHook(() => useLeadsPage());
    await waitFor(() => expect(result.current.formsAccess).toBe('admin'));
    act(() => { result.current.setDeleteConfirm({ kind: 'form', id: 'f1', name: 'Contact' }); });
    await act(async () => { await result.current.confirmDelete(); });
    return result;
  }

  it('CONTROL: a confirmed delete (200) closes the dialog with no error and DELETEs the FORM route', async () => {
    const result = await deleteWith(() => reply(200, { status: 'deleted' }));
    expect(result.current.deleteConfirm).toBeNull();
    expect(result.current.deleteError).toBeNull();
    const del = (global as any).fetch.mock.calls.find((c: any[]) => c[1]?.method === 'DELETE');
    expect(del[0]).toBe('/api/forms/f1?company_id=co-A');
  });
  it('a member refusal keeps the dialog open with the admin-only copy', async () => {
    const result = await deleteWith(() => reply(403, { error: 'FORBIDDEN_ROLE' }));
    expect(result.current.deleteConfirm).not.toBeNull();
    expect(result.current.deleteError).toBe(COMPANY_ADMIN_REQUIRED_MESSAGE);
  });
  it('a server error keeps the dialog open and says it was NOT deleted', async () => {
    const result = await deleteWith(() => reply(500, { error: 'Delete failed' }));
    expect(result.current.deleteConfirm).not.toBeNull();
    expect(result.current.deleteError).toMatch(/wasn't deleted/);
  });
  it('a lost response says it MAY not have been deleted (unknown, not "failed")', async () => {
    const result = await deleteWith(() => Promise.reject(new Error('offline')));
    expect(result.current.deleteConfirm).not.toBeNull();
    expect(result.current.deleteError).toMatch(/may not have been deleted/);
  });
});

describe('startGoogleAnalyticsConnect (/website-setup)', () => {
  it('CONTROL: POSTs and returns the authorization URL', async () => {
    (global as any).fetch = jest.fn(() => reply(200, { status: 'ok', authorizationUrl: 'https://accounts.google.com/o/oauth2/x' }));
    expect(await startGoogleAnalyticsConnect('co-A', '/website-setup')).toEqual({ ok: true, authorizationUrl: 'https://accounts.google.com/o/oauth2/x' });
    const [url, init] = (global as any).fetch.mock.calls[0];
    expect(url).toBe('/api/analytics/connect/google');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ companyId: 'co-A', returnTo: '/website-setup' });
  });
  it.each<[string, () => Promise<unknown>, string]>([
    ['the server message on a refusal', () => reply(500, { status: 'error', message: 'Google is not configured' }), 'Google is not configured'],
    ['a fallback on a 200 without a URL', () => reply(200, { status: 'ok' }), GA_CONNECT_FAILED_MESSAGE],
    ['a fallback on a network error', () => Promise.reject(new Error('offline')), GA_CONNECT_FAILED_MESSAGE],
  ])('returns %s, never a navigation', async (_n, answer, message) => {
    (global as any).fetch = jest.fn(answer);
    expect(await startGoogleAnalyticsConnect('co-A', '/website-setup')).toEqual({ ok: false, message });
  });
});

describe('which pages are wrapped (source contract)', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '../../..', rel), 'utf8');
  it.each(['pages/website-setup.tsx', 'pages/website-health.tsx', 'pages/lead-capture.tsx'])('%s: the default export renders CompanyAdminOnly', (rel) => {
    const src = read(rel);
    const exported = src.slice(src.indexOf('export default function'));
    expect(exported).toMatch(/<CompanyAdminOnly>/);
    expect(src.match(/export default function/g)).toHaveLength(1);
  });
  it('/integrations wraps ONLY focus=website (focus=data stays open to members)', () => {
    const src = read('components/integrationsMain.tsx');
    const exported = src.slice(src.indexOf('export default function IntegrationsPage'), src.indexOf('function IntegrationsPageContent'));
    expect(exported).toMatch(/if \(focus === 'website'\) \{[\s\S]*<CompanyAdminOnly[\s\S]*\}\s*return <IntegrationsPageContent \/>;/);
  });
  it('/website-setup no longer links to the POST-only connect API with a GET', () => {
    expect(read('pages/website-setup.tsx')).not.toMatch(/href=\{`\/api\/analytics\/connect\/google/);
  });
  it('CONTROL: the contract can fail (an unwrapped page has no CompanyAdminOnly in its export)', () => {
    const src = read('pages/leads.tsx');
    expect(src.slice(src.indexOf('export default function'))).not.toMatch(/<CompanyAdminOnly>/);
  });
});
