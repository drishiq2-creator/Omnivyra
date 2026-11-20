/**
 * @jest-environment jsdom
 *
 * /website-setup (audit U6, 2026-11-20):
 * F16 the setup read had no res.ok check; a failure restarted the wizard at step 0 ("You can keep going — nothing is
 *     lost"), and Continue then POSTed create_website. Now the wizard isn't shown until the read answers.
 * F17 integrationId/provider were never reset, so company A's connection id was PUT for company B.
 * F18 any server error on the publishing check rendered a verdict ("We could not publish yet.").
 * Plus: create/connect writes with a lost response or 5xx say "not sure" and re-read; 409 WEBSITE_ALREADY_EXISTS.
 *
 * SECRETS: none. No network (global fetch is a jest.fn routed by method + URL).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

let companyId = 'co-a';
jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: companyId }) }));

import WebsiteSetupPage from '../../../pages/website-setup';
import {
  CONNECTION_SAVE_UNKNOWN,
  PUBLISH_CHECK_NOT_RUN,
  WEBSITE_ALREADY_SET_UP,
  WEBSITE_SAVE_UNKNOWN,
  WEBSITE_SETUP_LOAD_FAILED,
} from '../../../lib/websiteSetup/websiteSetupCopy';

type Answer = { status: number; body?: unknown } | 'throw' | 'hang';
const toRes = (a: Answer) =>
  a === 'hang'
    ? new Promise<Response>(() => {})
    : a === 'throw'
    ? Promise.reject(new TypeError('Failed to fetch'))
    : Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body ?? {} } as Response);

/** routes: "METHOD path-fragment" -> queue (last answer repeats). Unmatched -> 200 {}. */
let routes: Record<string, Answer[]> = {};
const fetchMock = jest.fn((input: RequestInfo, init?: RequestInit) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const url = String(input);
  const key = Object.keys(routes).find((k) => {
    const [m, frag] = k.split(' ');
    return m === method && url.includes(frag);
  });
  if (!key) return toRes({ status: 200, body: {} });
  const q = routes[key];
  return toRes(q.length > 1 ? q.shift()! : q[0]);
});
const calls = (method: string, frag: string) =>
  fetchMock.mock.calls.filter(([u, i]) => ((i as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method && String(u).includes(frag));

const EMPTY_SETUP = { status: 200, body: { website: null, progress: { completed_steps: [] } } };
const NO_INTEGRATIONS = { status: 200, body: { integrations: [] } };
const urlInput = () => screen.queryByPlaceholderText('https://yoursite.com') as HTMLInputElement | null;

let warn: jest.SpyInstance;
beforeEach(() => {
  companyId = 'co-a';
  routes = {};
  fetchMock.mockClear();
  (global as any).fetch = fetchMock;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('F16 setup read', () => {
  it.each<[string, Record<string, Answer[]>]>([
    ['the setup read 503s', { 'GET /api/websites/setup': [{ status: 503 }], 'GET /api/integrations?': [NO_INTEGRATIONS] }],
    ['the setup read throws', { 'GET /api/websites/setup': ['throw'], 'GET /api/integrations?': [NO_INTEGRATIONS] }],
    ['the integrations read fails', { 'GET /api/websites/setup': [EMPTY_SETUP], 'GET /api/integrations?': [{ status: 500 }] }],
  ])('%s: failure + Retry, the wizard is NOT shown, no "nothing is lost"', async (_n, r) => {
    routes = r;
    render(<WebsiteSetupPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(WEBSITE_SETUP_LOAD_FAILED));
    expect(urlInput()).toBeNull();
    expect(screen.queryByText(/nothing is lost/)).toBeNull();
  });

  it('Retry re-reads and then shows the wizard', async () => {
    routes = { 'GET /api/websites/setup': [{ status: 503 }, EMPTY_SETUP], 'GET /api/integrations?': [NO_INTEGRATIONS] };
    render(<WebsiteSetupPage />);
    await waitFor(() => screen.getByRole('alert'));
    const before = calls('GET', '/api/websites/setup').length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await waitFor(() => expect(urlInput()).not.toBeNull());
    expect(calls('GET', '/api/websites/setup').length).toBe(before + 1);
  });

  it('while the read is in flight the wizard is not shown (no step-0 restart)', async () => {
    routes = { 'GET /api/websites/setup': ['hang'] };
    render(<WebsiteSetupPage />);
    await act(async () => {});
    expect(urlInput()).toBeNull();
    expect(screen.getByText('Loading your setup…')).toBeTruthy();
  });

  it('control: a genuinely new site shows the wizard at step 1', async () => {
    routes = { 'GET /api/websites/setup': [EMPTY_SETUP], 'GET /api/integrations?': [NO_INTEGRATIONS] };
    render(<WebsiteSetupPage />);
    await waitFor(() => expect(urlInput()).not.toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

async function submitUrl() {
  await waitFor(() => expect(urlInput()).not.toBeNull());
  fireEvent.change(urlInput()!, { target: { value: 'https://a.test' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
}

describe('create_website outcomes', () => {
  it('409 WEBSITE_ALREADY_EXISTS: "already set up" and a re-read', async () => {
    routes = {
      'GET /api/websites/setup': [EMPTY_SETUP],
      'GET /api/integrations?': [NO_INTEGRATIONS],
      'POST /api/websites/setup': [{ status: 409, body: { code: 'WEBSITE_ALREADY_EXISTS', error: 'x' } }],
    };
    render(<WebsiteSetupPage />);
    const reads = () => calls('GET', '/api/websites/setup').length;
    await waitFor(() => expect(reads()).toBe(1));
    await submitUrl();
    await waitFor(() => expect(screen.getByText(WEBSITE_ALREADY_SET_UP)).toBeTruthy());
    await waitFor(() => expect(reads()).toBe(2));
  });

  it.each<[string, Answer]>([['thrown', 'throw'], ['503', { status: 503 }]])(
    'a %s create is "not sure" and re-reads, never "Could not save"',
    async (_n, answer) => {
      routes = { 'GET /api/websites/setup': [EMPTY_SETUP], 'GET /api/integrations?': [NO_INTEGRATIONS], 'POST /api/websites/setup': [answer] };
      render(<WebsiteSetupPage />);
      await submitUrl();
      await waitFor(() => expect(screen.getByText(WEBSITE_SAVE_UNKNOWN)).toBeTruthy());
      expect(screen.queryByText(/Could not save your website/)).toBeNull();
      await waitFor(() => expect(calls('GET', '/api/websites/setup').length).toBe(2));
    },
  );

  it('control: a 400 refusal shows the server sentence', async () => {
    routes = { 'GET /api/websites/setup': [EMPTY_SETUP], 'GET /api/integrations?': [NO_INTEGRATIONS], 'POST /api/websites/setup': [{ status: 400, body: { error: 'name and canonical_url are required' } }] };
    render(<WebsiteSetupPage />);
    await submitUrl();
    await waitFor(() => expect(screen.getByText('name and canonical_url are required')).toBeTruthy());
  });
});

/** Resume at the Connect step: create_website + select_cms + verify_domain done. */
const AT_CONNECT = {
  status: 200,
  body: { website: { id: 'w1', name: 'A', canonical_url: 'https://a.test' }, progress: { completed_steps: ['create_website', 'select_cms', 'verify_domain'] } },
};
async function fillWordpressAndContinue() {
  fireEvent.change(screen.getByLabelText(/Website address/), { target: { value: 'https://a.test' } });
  fireEvent.change(screen.getByLabelText(/WordPress username/), { target: { value: 'u' } });
  fireEvent.change(screen.getByLabelText(/Application Password/), { target: { value: 'p' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
}

describe('F17 / connection writes / F18', () => {
  it("F17: after a company switch, company A's integration id is NOT reused for company B", async () => {
    routes = {
      'GET /api/websites/setup': [AT_CONNECT],
      'GET /api/integrations?': [{ status: 200, body: { integrations: [{ id: 'int-a', type: 'wordpress' }] } }, NO_INTEGRATIONS],
      'POST /api/integrations': ['hang'],
    };
    const { rerender } = render(<WebsiteSetupPage />);
    await waitFor(() => screen.getByLabelText(/WordPress username/));
    companyId = 'co-b';
    rerender(<WebsiteSetupPage />);
    // B has no integration; its provider must be chosen again, so the Connect step can't silently PUT A's id.
    await waitFor(() => expect(calls('GET', '/api/integrations?').length).toBe(2));
    await act(async () => {});
    expect(calls('PUT', '/api/integrations/int-a')).toHaveLength(0);
    expect(screen.queryByLabelText(/WordPress username/)).toBeNull();
    // Drive B through Platform -> Verify -> Connect: the connection must be CREATED for B, never PUT to A's id.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm platform/ })); });
    fireEvent.click(screen.getByRole('button', { name: /^WordPress/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    const onVerify = screen.getAllByRole('button').filter((b) => /continue|skip/i.test(b.textContent ?? ''));
    await act(async () => { fireEvent.click(onVerify[onVerify.length - 1]); });
    await waitFor(() => screen.getByLabelText(/WordPress username/));
    await fillWordpressAndContinue();
    expect(calls('PUT', '/api/integrations/int-a')).toHaveLength(0);
    expect(calls('POST', '/api/integrations').filter(([u]) => !String(u).includes('/test'))).toHaveLength(1);
  });

  it('a lost connection-create is "not sure" and re-reads', async () => {
    routes = {
      'GET /api/websites/setup': [AT_CONNECT],
      'GET /api/integrations?': [{ status: 200, body: { integrations: [] } }],
      'POST /api/integrations': ['throw'],
    };
    render(<WebsiteSetupPage />);
    await waitFor(() => screen.getByText('Connect it'));
    // No integration yet: pick the platform, pass Verify, then Connect (the CREATE path).
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirm platform/ })); });
    fireEvent.click(screen.getByRole('button', { name: /^WordPress/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    const onVerify = screen.getAllByRole('button').filter((b) => /continue|skip/i.test(b.textContent ?? ''));
    await act(async () => { fireEvent.click(onVerify[onVerify.length - 1]); });
    await waitFor(() => screen.getByLabelText(/WordPress username/));
    const reads = calls('GET', '/api/websites/setup').length;
    await fillWordpressAndContinue();
    await waitFor(() => expect(screen.getByText(CONNECTION_SAVE_UNKNOWN)).toBeTruthy());
    expect(calls('POST', '/api/integrations').filter(([u]) => !String(u).includes('/test'))).toHaveLength(1);
    await waitFor(() => expect(calls('GET', '/api/websites/setup').length).toBe(reads + 1));
  });

  it.each<[string, Answer]>([
    ['a 502 with no body', { status: 502, body: {} }],
    ["the route's own 500 { success: false } (carries a boolean, so status must decide)", { status: 500, body: { success: false, message: 'crash' } }],
  ])('F18: %s is "couldn\'t run", not "We could not publish yet."', async (_n, testAnswer) => {
    routes = {
      'GET /api/websites/setup': [AT_CONNECT],
      'GET /api/integrations?': [{ status: 200, body: { integrations: [{ id: 'int-a', type: 'wordpress' }] } }],
      'PUT /api/integrations/int-a': [{ status: 200, body: {} }],
      'POST /api/integrations/int-a/test': [testAnswer],
    };
    render(<WebsiteSetupPage />);
    await waitFor(() => screen.getByLabelText(/WordPress username/));
    await fillWordpressAndContinue();
    await waitFor(() => expect(screen.getByText(PUBLISH_CHECK_NOT_RUN)).toBeTruthy());
    expect(screen.queryByText('We could not publish yet.')).toBeNull();
  });

  it('F18 control: a real failed verdict (200, success:false) is still shown as a verdict', async () => {
    routes = {
      'GET /api/websites/setup': [AT_CONNECT],
      'GET /api/integrations?': [{ status: 200, body: { integrations: [{ id: 'int-a', type: 'wordpress' }] } }],
      'PUT /api/integrations/int-a': [{ status: 200, body: {} }],
      'POST /api/integrations/int-a/test': [{ status: 200, body: { success: false, message: 'Bad password' } }],
    };
    render(<WebsiteSetupPage />);
    await waitFor(() => screen.getByLabelText(/WordPress username/));
    await fillWordpressAndContinue();
    await waitFor(() => expect(screen.getByText('We could not publish yet.')).toBeTruthy());
    expect(screen.queryByText(PUBLISH_CHECK_NOT_RUN)).toBeNull();
  });

  it('a lost connection-update (PUT) is "not sure" and re-reads', async () => {
    routes = {
      'GET /api/websites/setup': [AT_CONNECT],
      'GET /api/integrations?': [{ status: 200, body: { integrations: [{ id: 'int-a', type: 'wordpress' }] } }],
      'PUT /api/integrations/int-a': ['throw'],
    };
    render(<WebsiteSetupPage />);
    await waitFor(() => screen.getByLabelText(/WordPress username/));
    const reads = calls('GET', '/api/websites/setup').length;
    await fillWordpressAndContinue();
    await waitFor(() => expect(screen.getByText(CONNECTION_SAVE_UNKNOWN)).toBeTruthy());
    await waitFor(() => expect(calls('GET', '/api/websites/setup').length).toBe(reads + 1));
  });
});
