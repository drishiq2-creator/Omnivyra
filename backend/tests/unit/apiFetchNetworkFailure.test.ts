/**
 * b3 2026-11-20 (pre-launch, BLOCKING for billed and sending screens): a lost connection is an UNKNOWN
 * outcome, so apiFetch must never present it as a server 503. Several screens read a 503 as "refused
 * before anything happened" ("Nothing was started / charged / submitted").
 */
jest.mock('../../../utils/getAuthToken', () => ({ getAuthToken: async () => 'tok' }));
jest.mock('../../../lib/supabaseBrowser', () => ({ getSupabaseBrowser: () => ({ auth: { refreshSession: async () => undefined } }) }));

import { apiFetch, isNetworkFailure, NETWORK_FAILURE_STATUS, NETWORK_FAILURE_CODE } from '../../../lib/apiFetch';
import { messageForOwnedIdentities } from '../../../components/prospects/OwnedIdentitiesPanel';
import { messageForObservations } from '../../../components/prospects/ProblemObservationsPanel';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });
beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));

describe('apiFetch: a lost connection is never a server 503', () => {
  it('fetch rejects → a non-ok response that is NOT 503, marked as a network failure', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const res = await apiFetch('/api/anything', { method: 'POST' });
    expect(res.ok).toBe(false);
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(NETWORK_FAILURE_STATUS);
    expect(isNetworkFailure(res)).toBe(true);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'Network unreachable', code: NETWORK_FAILURE_CODE });
  });

  it('control: a REAL server 503 is not a network failure', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ error: 'x' }), { status: 503 })) as unknown as typeof fetch;
    const res = await apiFetch('/api/anything');
    expect(res.status).toBe(503);
    expect(isNetworkFailure(res)).toBe(false);
  });

  it('control: an abort still throws (unchanged)', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    global.fetch = jest.fn(async () => { throw err; }) as unknown as typeof fetch;
    await expect(apiFetch('/api/anything')).rejects.toBe(err);
  });

  it('isNetworkFailure is false for nothing and for ordinary statuses', () => {
    expect(isNetworkFailure(null)).toBe(false);
    for (const status of [200, 400, 429, 500, 502, 503]) expect(isNetworkFailure({ status })).toBe(false);
  });
});

describe('the screens that read 503 tell the two apart', () => {
  const NET = 'Could not reach Omnivyra. Check your connection and retry.';
  it.each([
    ['owned identities', messageForOwnedIdentities],
    ['problem observations', messageForObservations],
  ])('%s: lost connection → connection message; a server 503 without a code → server message', (_l, fn) => {
    expect(fn(NETWORK_FAILURE_STATUS, { error: 'Network unreachable', code: NETWORK_FAILURE_CODE })).toBe(NET);
    expect(fn(503, null)).toBe('Omnivyra is temporarily unavailable. Please retry in a moment.');
  });
  it('a lost connection never gets the "not been altered" claim a route-coded 503 may carry', () => {
    expect(messageForOwnedIdentities(NETWORK_FAILURE_STATUS, { error: 'owned_identities_unavailable' })).toBe(NET);
    expect(messageForObservations(NETWORK_FAILURE_STATUS, { error: 'problem_observations_unavailable' })).toBe(NET);
    // control: the route's own coded 503 keeps its claim
    expect(messageForOwnedIdentities(503, { error: 'owned_identities_unavailable' })).toMatch(/not been altered/);
  });
});

// SOURCE-ORDER pins: these two handlers live inside a hook / a component, so the behavioural check is the
// order of the branches. If the code moves, re-anchor; indexOf -1 fails the toBeGreaterThan(-1) guards.
describe('handlers that used to read a lost connection as a server refusal', () => {
  const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8') as string;
  // force-sync is tested behaviourally in integrationsForceSyncStart.test.tsx (readForceSyncStart).
  it('render-image: the network check precedes the 429/503 "governance" branch', () => {
    const src = read('components/activity-workspace/CreatorWorkspace.tsx');
    const fn = src.slice(src.indexOf('const onGenerateImage'));
    // The exact statement, so a disabled check (`if (false && isNetworkFailure(res))`) does not match.
    const net = fn.indexOf('if (isNetworkFailure(res)) {');
    const gov = fn.indexOf('res.status === 429 || res.status === 503');
    expect(net).toBeGreaterThan(-1);
    expect(gov).toBeGreaterThan(net);
    expect(fn.slice(net, gov)).toMatch(/not sure the render started/);
  });
});

describe('components import the network-failure helpers from lib/networkFailure, not lib/apiFetch', () => {
  // 31 suites replace lib/apiFetch with a factory mock; an import from there would be undefined under
  // test (the check silently never fires, or isNetworkFailure throws). Positive control: the 5 sites.
  const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8') as string;
  const SITES = [
    'components/prospects/LeadSourcesPanel.tsx',
    'components/prospects/OwnedIdentitiesPanel.tsx',
    'components/prospects/ProblemObservationsPanel.tsx',
    'components/activity-workspace/CreatorWorkspace.tsx',
    'components/integrationsController.tsx',
  ];
  it.each(SITES)('%s', (f) => {
    const src = read(f);
    expect(src).toMatch(/from ['"][^'"]*lib\/networkFailure['"]/);
    expect(src).not.toMatch(/import \{[^}]*(NETWORK_FAILURE_STATUS|isNetworkFailure)[^}]*\} from ['"][^'"]*apiFetch['"]/);
  });
});

describe('repo guard: no client code fakes a 503 for a lost connection', () => {
  it('apiFetch constructs no 503 Response', () => {
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'lib/apiFetch.ts'), 'utf8') as string;
    expect(src).toMatch(/status: NETWORK_FAILURE_STATUS/);
    expect(src).not.toMatch(/status:\s*503/);
  });
});
