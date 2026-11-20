/**
 * ensureSessionForUser when the session READ fails (7c 2026-11-20, non-blocking 1). Before: a failed auth_sessions
 * read fell through like NOT_FOUND -> a fresh session was minted and the cookie rotated on every request during a
 * blip, and the foreign-session revoke was skipped. Now LOOKUP_FAILED answers { sessionId: null, minted: false }
 * (the function's own failure answer) with no insert and no Set-Cookie. CONTROL: a genuinely absent row (NOT_FOUND)
 * still mints - the pre-Wave-2B tolerance is unchanged.
 */
process.env.SESSION_COOKIE_SECRET = 'test-only-session-cookie-secret-0123456789abcdef';

type Result = { data: unknown; error: { message: string } | null };
let mockReadResult: Result = { data: null, error: null };
const mockInserts: unknown[] = [];

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (_t: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => mockReadResult;
    b.insert = (row: Record<string, unknown>) => {
      mockInserts.push(row);
      return { select: () => ({ single: async () => ({ data: { ...row }, error: null }) }) };
    };
    b.update = () => b;
    return b;
  },
}));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { ensureSessionForUser, SESSION_COOKIE_NAME } from '../../security/SessionAuthorityService';

function resStub() {
  const headers: Record<string, unknown> = {};
  return {
    headers,
    getHeader: (k: string) => headers[k.toLowerCase()],
    setHeader: (k: string, v: unknown) => { headers[k.toLowerCase()] = v; },
  };
}
const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=s-test-1.sig-test` } };
const input = { userId: 'u-test', supabaseUid: 'sb-u-test' };

beforeEach(() => { mockInserts.length = 0; });

describe('ensureSessionForUser: a failed session read never mints', () => {
  it('auth_sessions read errors -> { null, minted:false }, no insert, no Set-Cookie', async () => {
    mockReadResult = { data: null, error: { message: 'connection reset' } };
    const res = resStub();
    const r = await ensureSessionForUser(req as never, res as never, input);
    expect(r).toEqual({ sessionId: null, minted: false });
    expect(mockInserts).toHaveLength(0);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('CONTROL: row genuinely absent (NOT_FOUND) -> mints a session and sets the cookie, as before', async () => {
    mockReadResult = { data: null, error: null };
    const res = resStub();
    const r = await ensureSessionForUser(req as never, res as never, input);
    expect(r.minted).toBe(true);
    expect(mockInserts).toHaveLength(1);
    expect(res.headers['set-cookie']).toBeDefined();
  });
});
