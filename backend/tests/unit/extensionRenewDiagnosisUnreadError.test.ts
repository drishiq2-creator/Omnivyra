/**
 * Unread-error census: POST /api/extension/dispatch/renew. When the conditional renewal moves no
 * row, the route reads the command to return an actionable code. A FAILED read was taken as
 * "no such command" (404 COMMAND_NOT_FOUND) - an extension told that drops a live command. It now
 * answers 503 + Retry-After RENEWAL_STATE_UNREADABLE, for an error object AND a thrown rejection. (Standalone: extensionDispatchLeaseRenewal.test.ts reads
 * an absolute path from another machine and cannot load here.)
 */
const mockDb = { diagFails: false as false | 'error' | 'throw', row: null as Record<string, unknown> | null };

function mockBuilder() {
  const api: any = {
    select: () => api, eq: () => api, is: () => api, not: () => api, gt: () => api, lt: () => api, or: () => api,
    update: () => ({
      eq: function () { return this; }, is: function () { return this; }, gt: function () { return this; },
      select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), // renewal moved no row
    }),
    maybeSingle: () => mockDb.diagFails === 'throw'
      ? Promise.reject(new Error('socket hang up'))
      : Promise.resolve(mockDb.diagFails === 'error'
        ? { data: null, error: { message: 'connection reset' } }
        : { data: mockDb.row, error: null }),
  };
  return api;
}
jest.mock('@/backend/db/supabaseClient', () => ({ supabase: { from: () => mockBuilder() } }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => mockBuilder() } }));
jest.mock('@/backend/middleware/extensionAuthMiddleware', () => ({
  requireExtensionAuth: async () => ({ session: { userId: 'u1', orgId: 'org1', hmacNonce: 'n1' } }),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import renewHandler from '../../../pages/api/extension/dispatch/renew';

async function renew() {
  const res: any = { statusCode: 0, body: null, headers: {} as Record<string, string> };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  await (renewHandler as any)({ method: 'POST', body: { commandId: 'cmd_1', leaseId: 'lease-A' }, headers: {} }, res);
  return res;
}

beforeEach(() => { mockDb.diagFails = false; mockDb.row = null; jest.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => jest.restoreAllMocks());

it.each(['error', 'throw'] as const)('the diagnosis read FAILS (%s): 503 + Retry-After RENEWAL_STATE_UNREADABLE, never COMMAND_NOT_FOUND or RENEWAL_FAILED', async (mode) => {
  mockDb.diagFails = mode;
  const res = await renew();
  expect(res.statusCode).toBe(503);
  expect(res.headers['Retry-After']).toBe('5');
  expect(res.body).toEqual({ success: false, error: 'RENEWAL_STATE_UNREADABLE' });
});

it('NEGATIVE CONTROL: the read succeeds and finds no row - 404 COMMAND_NOT_FOUND, as before', async () => {
  const res = await renew();
  expect(res.statusCode).toBe(404);
  expect(res.body.error).toBe('COMMAND_NOT_FOUND');
});
