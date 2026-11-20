/**
 * Dev-bypass org inference (extensionAuthMiddleware, non-production only): an UNREADABLE community_ai_actions read
 * is not "no organization" (b3 read-failure rule; cb dropped-error list, a9 decision rows :34 / :43). A failed read
 * - an error object OR a thrown rejection - answers 503 BYPASS_ORG_UNREADABLE with Retry-After; only a READABLE empty
 * read answers 400 BYPASS_REQUIRES_ORG_ID (the genuinely-empty control); a found row yields the bypass session.
 */
type Outcome = { data: unknown; error: unknown } | 'throw';
let outcome: Outcome = { data: null, error: null };
const reads: string[] = [];
function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c;
  c.maybeSingle = () => {
    reads.push('community_ai_actions');
    return outcome === 'throw' ? Promise.reject(new Error('socket hang up')) : Promise.resolve(outcome);
  };
  return c;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => chain() } }));
jest.mock('../../services/extensionSessionService', () => ({
  verifyExtensionSessionToken: jest.fn(),
  verifyExtensionRequestSignature: jest.fn(),
}));

import { requireExtensionAuth } from '../../middleware/extensionAuthMiddleware';

function res() {
  const r = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  return Object.assign(r, {
    status(c: number) { r.statusCode = c; return this; },
    json(b: unknown) { r.body = b; return this; },
    setHeader(k: string, v: string) { r.headers[k.toLowerCase()] = v; return this; },
  });
}
const byCommand = () => ({ method: 'POST', url: '/api/extension/actions/result', body: { commandId: 'cmd-1' }, query: {}, headers: {} });
const byPoll = () => ({ method: 'GET', url: '/api/extension/commands', body: {}, query: {}, headers: {} });

const saved = { env: process.env.NODE_ENV, bypass: process.env.DEV_EXTENSION_AUTH_BYPASS };
beforeAll(() => { (process.env as Record<string, string>).NODE_ENV = 'test'; process.env.DEV_EXTENSION_AUTH_BYPASS = '1'; });
afterAll(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = saved.env;
  if (saved.bypass === undefined) delete process.env.DEV_EXTENSION_AUTH_BYPASS; else process.env.DEV_EXTENSION_AUTH_BYPASS = saved.bypass;
});
beforeEach(() => { outcome = { data: null, error: null }; reads.length = 0; });

describe.each([['by command id', byCommand], ['by the pending-commands poll', byPoll]])('dev-bypass org inference %s', (_n, req) => {
  it.each([
    ['an error object', { data: null, error: { message: 'connection reset' } } as Outcome],
    ['a thrown rejection', 'throw' as Outcome],
  ])('UNREADABLE (%s) -> 503 BYPASS_ORG_UNREADABLE + Retry-After, no session', async (_k, o) => {
    outcome = o;
    const r = res();
    await expect(requireExtensionAuth(req() as never, r as never)).resolves.toBeNull();
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ success: false, error: 'BYPASS_ORG_UNREADABLE' });
    expect(r.headers['retry-after']).toBe('5');
  });

  it('CONTROL: readable and EMPTY -> 400 BYPASS_REQUIRES_ORG_ID (genuinely no organization)', async () => {
    const r = res();
    await expect(requireExtensionAuth(req() as never, r as never)).resolves.toBeNull();
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ success: false, error: 'BYPASS_REQUIRES_ORG_ID' });
    expect(reads).toEqual(['community_ai_actions']);
  });

  it('readable with a row -> the bypass session carries that organization', async () => {
    outcome = { data: { organization_id: 'org-1' }, error: null };
    const r = res();
    await expect(requireExtensionAuth(req() as never, r as never)).resolves.toMatchObject({ session: { orgId: 'org-1' } });
    expect(r.statusCode).toBe(0);
  });
});

it('an explicit organization in the body is used WITHOUT any read (the inference never runs)', async () => {
  outcome = 'throw';
  const r = res();
  const out = await requireExtensionAuth({ method: 'POST', url: '/x', body: { organization_id: 'org-2' }, query: {}, headers: {} } as never, r as never);
  expect(out).toMatchObject({ session: { orgId: 'org-2' } });
  expect(reads).toEqual([]);
});
