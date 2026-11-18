/**
 * @jest-environment jsdom
 *
 * Phase 1 of the deleted-campaign takeover fix (owner ruling 2026-11-18): every live caller of
 * POST /api/campaigns/create-12week-plan continues with the `campaign_id` the SERVER returns,
 * so phase 2 (the server mints its own id) cannot strand a client on the id it sent.
 *
 * The three callers, each driven through its real code with fetch mocked:
 *   - hooks/useCampaignPlanningState.tsx        generate12WeekPlan (renderHook)
 *   - components/campaign-ai/useCampaignPlanCreation.ts   create12WeekPlan
 *   - lib/campaign-navigation-logic.ts          AIIntegration.generate12WeekPlan
 *
 * For each: (a) NO-OP: same id returned -> identical behaviour to before;
 *           (b) ADOPTION: a different id returned -> the returned id is used everywhere after the
 *               response and the sent id appears nowhere;
 *           (c) BACKWARD COMPAT: no campaign_id -> the sent id is used.
 */

import { renderHook, act } from '@testing-library/react';

const SENT = '11111111-1111-4111-8111-111111111111';
const RETURNED = '99999999-9999-4999-8999-999999999999';

// ---- one ordered event log for every observable side effect --------------------------------
type Ev = { kind: string; url: string };
let log: Ev[] = [];
let createResponseBody: unknown = {};
const CREATE = '/api/campaigns/create-12week-plan';

function respond(url: string) {
  if (url.startsWith(CREATE)) {
    return { ok: true, status: 200, json: async () => createResponseBody };
  }
  if (url.startsWith('/api/campaigns/retrieve-plan')) {
    return { ok: true, status: 200, json: async () => ({ plan: 'p' }) };
  }
  if (url.startsWith('/api/campaigns/get-weekly-plans')) {
    return { ok: true, status: 200, json: async () => [] };
  }
  return { ok: false, status: 404, json: async () => ({}) };
}

const fetchMock = jest.fn(async (url: string, _init?: unknown) => { log.push({ kind: 'fetch', url: String(url) }); return respond(String(url)); });
const fetchWithAuthMock = jest.fn(async (url: string, _init?: unknown) => { log.push({ kind: 'fetchWithAuth', url: String(url) }); return respond(String(url)); });

jest.mock('../../../components/community-ai/fetchWithAuth', () => ({
  fetchWithAuth: (url: string, init?: unknown) => fetchWithAuthMock(url, init),
}));
jest.mock('next/router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn(), query: {}, pathname: '/campaign-planning' }) }));
// The ACTIVE company (04, 2026-11-18): a new campaign is created under CompanyContext.selectedCompanyId.
const ACTIVE_COMPANY = 'c0a00000-0000-4000-8000-00000000000a';
let mockSelectedCompanyId = ACTIVE_COMPANY;
jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ user: { userId: 'u-1' }, selectedCompanyId: mockSelectedCompanyId }) }));
jest.mock('../../../components/CampaignAIChat', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../components/AIContentIntegration', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../components/ContentCreationPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../components/VoiceNotesComponent', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../components/WeeklyRefinementInterface', () => ({ __esModule: true, default: () => null }));

import { resolveReturnedCampaignId } from '../../../lib/campaign/returnedCampaignId';
import { useCampaignPlanCreation } from '../../../components/campaign-ai/useCampaignPlanCreation';
import { AIIntegration } from '../../../lib/campaign-navigation-logic';
import { useCampaignPlanningState } from '../../../hooks/useCampaignPlanningState';

const originalLocation = window.location;
let search = '';
beforeEach(() => {
  log = [];
  search = '';
  createResponseBody = {};
  fetchMock.mockClear(); fetchWithAuthMock.mockClear();
  (global as any).fetch = fetchMock;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get pathname() { return '/campaign-planning'; },
      get search() { return search; },
      get href() { return `http://localhost/campaign-planning${search}`; },
      set href(v: string) { log.push({ kind: 'navigate', url: v }); },
    },
  });
  jest.spyOn(window.history, 'replaceState').mockImplementation((_s, _t, url) => { log.push({ kind: 'replaceState', url: String(url) }); });
  jest.spyOn(window.history, 'pushState').mockImplementation((_s, _t, url) => { log.push({ kind: 'pushState', url: String(url) }); });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

/** Events after (not including) the create-12week-plan call. */
function afterCreate(): Ev[] {
  const i = log.findIndex(e => e.url.startsWith(CREATE));
  expect(i).toBeGreaterThanOrEqual(0);
  return log.slice(i + 1);
}
const mentions = (evs: Ev[], id: string) => evs.filter(e => e.url.includes(id));

// =============================================================================================
describe('resolveReturnedCampaignId (helper)', () => {
  it('returns the server id when present (same or different)', () => {
    expect(resolveReturnedCampaignId(SENT, { campaign_id: SENT })).toBe(SENT);
    expect(resolveReturnedCampaignId(SENT, { campaign_id: RETURNED })).toBe(RETURNED);
    expect(resolveReturnedCampaignId(SENT, { success: true, campaign_id: RETURNED, data: { campaignId: SENT } })).toBe(RETURNED);
  });
  it('keeps the sent id for an old server / unusable value', () => {
    for (const body of [{}, { success: true, data: { campaignId: RETURNED } }, { campaign_id: '' }, { campaign_id: null },
      { campaign_id: 42 }, { campaign_id: { id: RETURNED } }, null, undefined, 'x', [RETURNED]]) {
      expect(resolveReturnedCampaignId(SENT, body)).toBe(SENT);
    }
  });
});

// =============================================================================================
describe('lib/campaign-navigation-logic AIIntegration.generate12WeekPlan', () => {
  it('(a) NO-OP: same id returned -> navigates to the sent id, nothing else', async () => {
    createResponseBody = { success: true, campaign_id: SENT };
    await AIIntegration.generate12WeekPlan(SENT);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body).campaignId).toBe(SENT);
    expect(afterCreate()).toEqual([{ kind: 'navigate', url: `/campaign-details/${SENT}` }]);
  });
  it('(b) ADOPTION: a different id returned -> navigates to the RETURNED id only', async () => {
    createResponseBody = { success: true, campaign_id: RETURNED };
    await AIIntegration.generate12WeekPlan(SENT);
    const after = afterCreate();
    expect(after).toEqual([{ kind: 'navigate', url: `/campaign-details/${RETURNED}` }]);
    expect(mentions(after, SENT)).toEqual([]);
  });
  it('(c) BACKWARD COMPAT: no campaign_id -> navigates to the sent id', async () => {
    createResponseBody = { success: true, data: { campaignId: SENT } };
    await AIIntegration.generate12WeekPlan(SENT);
    expect(afterCreate()).toEqual([{ kind: 'navigate', url: `/campaign-details/${SENT}` }]);
  });
  it('(c) a non-JSON 200 body still navigates to the sent id (no behaviour change)', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => { log.push({ kind: 'fetch', url }); return { ok: true, status: 200, json: async () => { throw new Error('not json'); } } as any; });
    await AIIntegration.generate12WeekPlan(SENT);
    expect(afterCreate()).toEqual([{ kind: 'navigate', url: `/campaign-details/${SENT}` }]);
  });
});

// =============================================================================================
describe('components/campaign-ai/useCampaignPlanCreation create12WeekPlan', () => {
  function build() {
    const spies = {
      setIsLoading: jest.fn(), setRetrievePlanData: jest.fn(), setMessages: jest.fn(),
      setShowDateSelection: jest.fn(), setSelectedPlan: jest.fn(),
    };
    search = '?companyId=co-1';
    const create = useCampaignPlanCreation({
      campaignId: SENT, isOpen: true, context: 'x', selectedPlan: 'plan text',
      generateDefaultPlan: () => 'default', selectedProvider: 'demo', resolvedCompanyId: 'co-1',
      structuredPlan: null, resolveWorkingDurationWeeks: () => 12, getProviderName: () => 'Demo',
      ...spies,
    });
    return { create, spies };
  }
  const messages = (spies: any) => spies.setMessages.mock.calls.map((c: any) => c[0]([])).flat();

  it('(a) NO-OP: same id returned -> refetch, message and navigation use the sent id', async () => {
    createResponseBody = { success: true, campaign_id: SENT };
    const { create, spies } = build();
    await create('2026-12-01', 12);
    expect(JSON.parse((fetchWithAuthMock.mock.calls[0][1] as any).body).campaignId).toBe(SENT);
    expect(afterCreate()).toEqual([
      { kind: 'fetch', url: `/api/campaigns/retrieve-plan?campaignId=${SENT}` },
      { kind: 'navigate', url: `/campaign-details/${SENT}?companyId=co-1&focus=weekly-blueprint` },
    ]);
    expect(spies.setRetrievePlanData).toHaveBeenCalledWith({ plan: 'p' });
    expect(messages(spies).map((m: any) => m.campaignId)).toEqual([SENT]);
  });
  it('(b) ADOPTION: a different id returned -> the RETURNED id everywhere, the sent id nowhere', async () => {
    createResponseBody = { success: true, campaign_id: RETURNED };
    const { create, spies } = build();
    await create('2026-12-01', 12);
    const after = afterCreate();
    expect(after).toEqual([
      { kind: 'fetch', url: `/api/campaigns/retrieve-plan?campaignId=${RETURNED}` },
      { kind: 'navigate', url: `/campaign-details/${RETURNED}?companyId=co-1&focus=weekly-blueprint` },
    ]);
    expect(mentions(after, SENT)).toEqual([]);
    expect(messages(spies).map((m: any) => m.campaignId)).toEqual([RETURNED]);
  });
  it('(b) ADOPTION: an error after the response still reports the RETURNED id', async () => {
    createResponseBody = { success: true, campaign_id: RETURNED };
    const { create, spies } = build();
    fetchMock.mockImplementationOnce(async () => { throw new Error('network'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await create('2026-12-01', 12);
    expect(messages(spies).map((m: any) => m.campaignId)).toEqual([RETURNED]);
  });
  it('(c) BACKWARD COMPAT: no campaign_id -> the sent id is used', async () => {
    createResponseBody = { success: true, data: { campaignId: SENT } };
    const { create, spies } = build();
    await create('2026-12-01', 12);
    expect(afterCreate()).toEqual([
      { kind: 'fetch', url: `/api/campaigns/retrieve-plan?campaignId=${SENT}` },
      { kind: 'navigate', url: `/campaign-details/${SENT}?companyId=co-1&focus=weekly-blueprint` },
    ]);
    expect(messages(spies).map((m: any) => m.campaignId)).toEqual([SENT]);
  });
});

// =============================================================================================
describe('hooks/useCampaignPlanningState generate12WeekPlan', () => {
  async function run() {
    // jsdom's crypto has no randomUUID: provide the browser mint, pinned to SENT.
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, writable: true, value: () => SENT });
    const { result } = renderHook(() => useCampaignPlanningState());
    await act(async () => { await result.current.createNewCampaign(); });
    expect(result.current.campaignId).toBe(SENT);
    expect(log).toContainEqual({ kind: 'pushState', url: `/campaign-planning?campaignId=${SENT}` });
    await act(async () => { await result.current.generate12WeekPlan(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const sentBody = JSON.parse((fetchMock.mock.calls.find(c => String(c[0]) === CREATE)![1] as any).body);
    expect(sentBody.campaignId).toBe(SENT);
    return result;
  }
  // The hook's own per-campaign effects (strategy-status etc.) re-run when campaignId changes;
  // those are refetches too, so they are part of "after the response".
  const kinds = (evs: Ev[]) => evs.filter(e => e.kind !== 'fetchWithAuth' && !e.url.includes('/api/campaigns/') || e.url.includes('get-weekly-plans'));

  afterEach(() => { mockSelectedCompanyId = ACTIVE_COMPANY; });

  it('REGRESSION 025a03a52: the new-campaign request carries the ACTIVE company (never the 400 COMPANY_REQUIRED path)', async () => {
    createResponseBody = { success: true, campaign_id: SENT };
    await run();
    const sentBody = JSON.parse((fetchMock.mock.calls.find(c => String(c[0]) === CREATE)![1] as any).body);
    expect(sentBody.companyId).toBe(ACTIVE_COMPANY);
  });

  it('no active company -> NO create request, a plain "Select a company" notice (fail closed, never the 400)', async () => {
    mockSelectedCompanyId = '';
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, writable: true, value: () => SENT });
    const { result } = renderHook(() => useCampaignPlanningState());
    await act(async () => { await result.current.createNewCampaign(); });
    await act(async () => { await result.current.generate12WeekPlan(); });
    expect(fetchMock.mock.calls.filter(c => String(c[0]) === CREATE)).toEqual([]);
    expect(result.current.notice).toEqual({ type: 'info', message: 'Select a company to create a campaign.' });
  });

  it('(a) NO-OP: same id returned -> no URL replace, refetch + navigation with the sent id', async () => {
    createResponseBody = { success: true, campaign_id: SENT };
    const result = await run();
    const after = afterCreate();
    expect(kinds(after)).toEqual([
      { kind: 'fetch', url: `/api/campaigns/get-weekly-plans?campaignId=${SENT}` },
      { kind: 'navigate', url: `/campaign-details/${SENT}` },
    ]);
    expect(after.filter(e => e.kind === 'replaceState' || e.kind === 'pushState')).toEqual([]);
    expect(mentions(after, RETURNED)).toEqual([]);
    // no state re-fetch storm: nothing campaign-scoped re-ran after the response
    expect(after.filter(e => e.kind === 'fetchWithAuth')).toEqual([]);
    expect(result.current.campaignId).toBe(SENT);
    expect(result.current.campaignData.id).toBe(SENT);
  });

  it('(b) ADOPTION: a different id returned -> state, URL (replace), refetch and navigation use the RETURNED id', async () => {
    createResponseBody = { success: true, campaign_id: RETURNED };
    const result = await run();
    const after = afterCreate();
    expect(kinds(after)).toEqual([
      { kind: 'replaceState', url: `/campaign-planning?campaignId=${RETURNED}` },
      { kind: 'fetch', url: `/api/campaigns/get-weekly-plans?campaignId=${RETURNED}` },
      { kind: 'navigate', url: `/campaign-details/${RETURNED}` },
    ]);
    expect(after.filter(e => e.kind === 'pushState')).toEqual([]);
    expect(mentions(after, SENT)).toEqual([]);
    expect(result.current.campaignId).toBe(RETURNED);
    expect(result.current.campaignData.id).toBe(RETURNED);
  });

  it('(c) BACKWARD COMPAT: no campaign_id -> the sent id is used', async () => {
    createResponseBody = { success: true, data: { campaignId: SENT } };
    const result = await run();
    const after = afterCreate();
    expect(kinds(after)).toEqual([
      { kind: 'fetch', url: `/api/campaigns/get-weekly-plans?campaignId=${SENT}` },
      { kind: 'navigate', url: `/campaign-details/${SENT}` },
    ]);
    expect(mentions(after, RETURNED)).toEqual([]);
    expect(result.current.campaignId).toBe(SENT);
  });
});
