/**
 * @jest-environment jsdom
 *
 * Callers of GET /api/integrations render "couldn't load", never an empty list, when the read fails (b3, Rule 1).
 *  - /leads (useLeadsPage): behaviour, with a genuinely-empty control.
 *  - blogs/new and /website-setup are 900-line pages; their contract is pinned at the source (each branches on the
 *    shared reader's null), with a control that the pin can fail.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: 'co-A', userRole: 'COMPANY_ADMIN' }) }));
jest.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: jest.fn(), replace: jest.fn(), isReady: true }) }));
jest.mock('../../../lib/analytics/activationEvents', () => ({ trackActivationEvent: jest.fn() }));

import { useLeadsPage } from '../../../hooks/useLeadsPage';

const reply = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body });
function stub(integrations: () => Promise<unknown>) {
  (global as any).fetch = jest.fn((url: string) => {
    if (url.startsWith('/api/integrations')) return integrations();
    if (url.startsWith('/api/leads')) return reply(200, { leads: [] });
    if (url.startsWith('/api/forms')) return reply(200, { forms: [] });
    return reply(200, { admin: true });
  });
}
afterEach(() => { delete (global as any).fetch; });

describe('/leads webhook connections', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['a 503', () => reply(503, { code: 'INTEGRATIONS_UNAVAILABLE' })],
    ['a lost response', () => Promise.reject(new Error('offline'))],
    ['a 200 without the list', () => reply(200, {})],
  ])('%s → unavailable (not "no webhooks")', async (_n, answer) => {
    stub(answer);
    const { result } = renderHook(() => useLeadsPage());
    await waitFor(() => expect(result.current.webhookIntegrationsUnavailable).toBe(true));
    expect(result.current.webhookIntegrations).toEqual([]);
  });

  it('CONTROL: a genuinely empty list is available-and-empty', async () => {
    stub(() => reply(200, { integrations: [], secrets_visible: true }));
    const { result } = renderHook(() => useLeadsPage());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.webhookIntegrationsUnavailable).toBe(false);
    expect(result.current.webhookIntegrations).toEqual([]);
    expect(result.current.webhookSecretsVisible).toBe(true); // the hotfix's flag still reaches the page
  });
});

describe('source contract: the heavy pages branch on the shared reader', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '../../..', rel), 'utf8');
  it('blogs/new: an unread list sets cmsIntegrationsUnavailable and says so (publish + panel)', () => {
    const src = read('components/blog/blogsNewMain.tsx');
    expect(src).toMatch(/readIntegrationsList\(r\.ok, await r\.json\(\)\.catch\(\(\) => null\)\)/);
    expect(src).toMatch(/setCmsIntegrationsUnavailable\(integrationData === null\)/);
    expect((src.match(/CMS_CONNECTIONS_UNAVAILABLE_MESSAGE/g) || []).length).toBeGreaterThanOrEqual(3); // def + 2 uses
  });
  it('/website-setup: resume warns on an unread list; the checklist is UNKNOWN, not Pending', () => {
    const src = read('pages/website-setup.tsx');
    expect((src.match(/readIntegrationsList\(/g) || []).length).toBe(2);
    expect(src).toMatch(/if \(intList === null\) \{/);
    expect(src).toMatch(/setReadiness\(\{ unavailable: true \}\)/);
    expect(src).toMatch(/readiness\?\.unavailable \?/);
  });
  it('CONTROL: no caller still reads `.integrations || []` from an unchecked body', () => {
    for (const rel of ['components/blog/blogsNewMain.tsx', 'pages/website-setup.tsx', 'hooks/useLeadsPage.tsx']) {
      expect(read(rel)).not.toMatch(/\.integrations \|\| \[\]/);
    }
  });
});
