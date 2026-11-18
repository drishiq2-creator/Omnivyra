/**
 * @jest-environment jsdom
 *
 * WhatsApp launch gate (b3, 2026-11-18): every WhatsApp connect/broadcast entry point is hidden unless
 * GET /api/whatsapp/status answers 200 { enabled: true } (a9's contract). FAIL CLOSED: loading, an
 * error, 401/404, a lost connection (apiFetch's synthetic 503) or anything but enabled === true.
 * The server also refuses WhatsApp writes while off; this gate keeps the UI honest about it.
 */
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor, renderHook } from '@testing-library/react';

const apiFetch = jest.fn();
jest.mock('../../../lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@/lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/head', () => ({ __esModule: true, default: () => null }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: jest.fn(), replace: jest.fn(), isReady: true, pathname: '/' }) }));
jest.mock('../../../components/CompanyContext', () => ({
  useCompanyContext: () => ({ selectedCompanyId: 'c1', user: { userId: 'u1' }, isLoading: false, userRole: 'COMPANY_ADMIN' }),
}));
jest.mock('@/components/CompanyContext', () => ({
  useCompanyContext: () => ({ selectedCompanyId: 'c1', user: { userId: 'u1' }, isLoading: false, userRole: 'COMPANY_ADMIN' }),
}));

import { WhatsAppGate, WHATSAPP_COMING_SOON } from '../../../lib/whatsapp/whatsappAvailability';
import OutreachPage from '../../../pages/integrations/outreach';
import WhatsAppHubPage from '../../../pages/whatsapp/index';
import { useSocialPlatforms } from '../../../hooks/useSocialPlatforms';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let fetchSpy: jest.Mock;
function statusIs(r: unknown) {
  apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/whatsapp/status') {
      if (r instanceof Error) throw r;
      return r;
    }
    if (url.startsWith('/api/social-accounts/status')) {
      return reply(200, { accounts: [
        { platform_key: 'facebook', platform_label: 'Facebook', category: 'social', connected: false, oauth_configured: true },
        { platform_key: 'whatsapp', platform_label: 'WhatsApp', category: 'social', connected: false, oauth_configured: true },
      ] });
    }
    return reply(200, {});
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  fetchSpy = jest.fn(async () => reply(200, { accounts: [], broadcasts: [], data: [] }));
  (global as { fetch?: unknown }).fetch = fetchSpy;
});

describe('WhatsAppGate fails closed', () => {
  it('200 { enabled: true } -> the real content', async () => {
    statusIs(reply(200, { enabled: true }));
    render(<WhatsAppGate><p>REAL</p></WhatsAppGate>);
    expect(await screen.findByText('REAL')).toBeInTheDocument();
  });
  it.each([
    ['enabled false', reply(200, { enabled: false })],
    ['enabled "true" (not a boolean)', reply(200, { enabled: 'true' })],
    ['401', reply(401, { error: 'unauthorized' })],
    ['404 (route not deployed)', reply(404, {})],
    ['lost connection (apiFetch synthetic 503)', reply(503, { error: 'Network unreachable' })],
    ['apiFetch throws', new Error('boom')],
  ])('%s -> coming soon, never the content', async (_n, r) => {
    statusIs(r);
    render(<WhatsAppGate><p>REAL</p></WhatsAppGate>);
    expect(await screen.findByText(WHATSAPP_COMING_SOON)).toBeInTheDocument();
    expect(screen.queryByText('REAL')).toBeNull();
  });
  it('while loading: neither the content nor the coming-soon line', () => {
    apiFetch.mockImplementation(() => new Promise(() => {}));
    render(<WhatsAppGate><p>REAL</p></WhatsAppGate>);
    expect(screen.queryByText('REAL')).toBeNull();
    expect(screen.queryByText(WHATSAPP_COMING_SOON)).toBeNull();
  });
});

describe('the /whatsapp pages are gated', () => {
  it('hidden -> coming soon AND no WhatsApp API call is made', async () => {
    statusIs(reply(200, { enabled: false }));
    render(<WhatsAppHubPage />);
    expect(await screen.findByText(WHATSAPP_COMING_SOON)).toBeInTheDocument();
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/api/whatsapp') || u.includes('/api/analytics/whatsapp'))).toEqual([]);
  });
});

describe('outreach card', () => {
  it('hidden -> no "Open WhatsApp" link, the coming-soon line instead', async () => {
    statusIs(reply(200, { enabled: false }));
    render(<OutreachPage />);
    expect(await screen.findByText(WHATSAPP_COMING_SOON)).toBeInTheDocument();
    expect(screen.queryByText('Open WhatsApp')).toBeNull();
  });
  it('enabled -> the link is shown', async () => {
    statusIs(reply(200, { enabled: true }));
    render(<OutreachPage />);
    expect(await screen.findByText('Open WhatsApp')).toBeInTheDocument();
  });
});

describe('social platforms list', () => {
  it('hidden -> no WhatsApp row; enabled -> the row is there', async () => {
    statusIs(reply(200, { enabled: false }));
    const off = renderHook(() => useSocialPlatforms());
    await waitFor(() => expect(off.result.current.visibleSocial.map((p: { platform_key: string }) => p.platform_key)).toContain('facebook'));
    expect(off.result.current.visibleSocial.map((p: { platform_key: string }) => p.platform_key)).not.toContain('whatsapp');
    off.unmount();

    statusIs(reply(200, { enabled: true }));
    const on = renderHook(() => useSocialPlatforms());
    await waitFor(() => expect(on.result.current.visibleSocial.map((p: { platform_key: string }) => p.platform_key)).toContain('whatsapp'));
  });
});
