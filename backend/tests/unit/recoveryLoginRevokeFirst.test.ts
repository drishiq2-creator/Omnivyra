/**
 * Recovery-code login order (b3 ruling 2026-11-20): verify the code WITHOUT consuming -> revoke every session ->
 * consume (CAS on unused) -> mint. Before: a failed revoke was swallowed ("non-fatal") and a fresh session was minted
 * while the old - possibly attacker - sessions stayed live.
 * REAL: the route, RecoveryCodeService (argon2id, in-memory recovery_codes honouring the production query shapes).
 * FAKED: users lookup, session authority (revoke configurable, mint recorded), limiter (permissive), audit, logger.
 */
export {};
jest.setTimeout(120_000); // real argon2id

interface Row { id: string; user_id: string; code_hash: string; batch_id: string; used_at: string | null; used_ip: string | null }
const table: Row[] = [];
let seq = 0;
interface State { op: 'select' | 'insert' | 'update'; payload: any; eq: Record<string, unknown>; isNull: string[]; selectAfterUpdate: boolean }
const matches = (r: Row, st: State) =>
  Object.entries(st.eq).every(([k, v]) => (r as any)[k] === v) && st.isNull.every((k) => (r as any)[k] == null);
function exec(st: State) {
  if (st.op === 'insert') {
    for (const raw of st.payload as Record<string, unknown>[]) table.push({ id: `row-${++seq}`, used_at: null, used_ip: null, ...(raw as any) });
    return { data: null, error: null };
  }
  const hit = table.filter((r) => matches(r, st));
  if (st.op === 'select') return { data: hit, error: null };
  for (const r of hit) Object.assign(r, st.payload);
  return { data: st.selectAfterUpdate ? hit.map((r) => ({ id: r.id })) : null, error: null };
}
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => {
    const st: State = { op: 'select', payload: null, eq: {}, isNull: [], selectAfterUpdate: false };
    const b: any = {
      select: () => { if (st.op === 'update') st.selectAfterUpdate = true; return b; },
      insert: (p: unknown) => { st.op = 'insert'; st.payload = p; return b; },
      update: (p: unknown) => { st.op = 'update'; st.payload = p; return b; },
      eq: (k: string, v: unknown) => { st.eq[k] = v; return b; },
      is: (k: string, v: unknown) => { if (v === null) st.isNull.push(k); return b; },
      then: (res: any, rej?: any) => Promise.resolve(exec(st)).then(res, rej),
    };
    return b;
  },
}));
const USER = 'aaaaaaaa-0000-4000-8000-00000000000a';
jest.mock('../../db/supabaseClient', () => {
  const b: any = { select: () => b, eq: () => b, maybeSingle: () => b,
    then: (ok: any) => Promise.resolve({ data: { id: 'aaaaaaaa-0000-4000-8000-00000000000a', supabase_uid: 'sb-a', is_deleted: false }, error: null }).then(ok) };
  return { supabase: { from: () => b, rpc: jest.fn() } };
});
const mockRevokeAll = jest.fn();
const mockMinted: string[] = [];
jest.mock('../../security/SessionAuthorityService', () => ({
  revokeAllSessionsForUser: (...a: unknown[]) => mockRevokeAll(...a),
  createSession: async (input: { userId: string }) => { mockMinted.push(input.userId); return { cookieValue: 'c', session: { id: `s-${mockMinted.length}` } }; },
  attachSessionCookie: jest.fn(),
}));
jest.mock('../../security/stepup/StepUpSessionService', () => ({ revokeForAuthSession: jest.fn(async () => 0) }));
jest.mock('../../security/MfaIntent', () => ({ clearMfaIntent: jest.fn() }));
jest.mock('../../security/MfaAttemptLimiter', () => ({ check: jest.fn(() => ({ allowed: true })), recordFailure: jest.fn(), reset: jest.fn() }));
jest.mock('../../security/audit/SecurityAuditService', () => ({ logSecurityEvent: jest.fn(async () => undefined), snapshotFromPrincipal: jest.fn(() => ({})) }));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { regenerate } = require('../../security/totp/RecoveryCodeService');
const handler = require('../../../pages/api/auth/recovery-login').default;

async function recover(code: string) {
  const res: any = { statusCode: 200, body: null, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; }, getHeader() { return undefined; },
    status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: {}, body: { email: 'pat@recover.test', code }, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}
const unused = () => table.filter((r) => r.used_at === null).length;

beforeEach(() => { table.length = 0; seq = 0; mockRevokeAll.mockReset(); mockMinted.length = 0; });

describe('recovery login: revoke every session BEFORE consuming the code', () => {
  it('revoke FAILS -> 503 SESSIONS_NOT_REVOKED, NO session minted, the code is NOT consumed (still usable)', async () => {
    const { codes } = await regenerate({ userId: USER });
    const before = unused();
    mockRevokeAll.mockRejectedValueOnce(new Error('SECURITY_READ_FAILED:auth_sessions'));
    const r = await recover(codes[0]);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ code: 'SESSIONS_NOT_REVOKED' });
    expect(mockMinted).toEqual([]);
    expect(unused()).toBe(before);
    // the same code then works once the revoke works
    mockRevokeAll.mockResolvedValueOnce(3);
    const ok = await recover(codes[0]);
    expect(ok.statusCode).toBe(200);
    expect(mockMinted).toEqual([USER]);
    expect(unused()).toBe(before - 1);
  });

  it('CONTROL: revoke succeeds -> code consumed, ONE session minted, revoked count reported', async () => {
    const { codes } = await regenerate({ userId: USER });
    mockRevokeAll.mockResolvedValue(2);
    const r = await recover(codes[1]);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: true, revokedOtherSessions: 2 });
    expect(mockMinted).toEqual([USER]);
    expect(mockRevokeAll).toHaveBeenCalledTimes(1);
  });

  it('a wrong code revokes nothing and mints nothing', async () => {
    await regenerate({ userId: USER });
    const r = await recover('ZZZZ-ZZZZ-ZZZZ');
    expect(r.statusCode).toBe(401);
    expect(mockRevokeAll).not.toHaveBeenCalled();
    expect(mockMinted).toEqual([]);
  });

  it('consume RACE lost (the code was consumed by a concurrent request after the revoke) -> refused, nothing minted', async () => {
    const { codes } = await regenerate({ userId: USER });
    mockRevokeAll.mockImplementation(async () => { for (const r of table) r.used_at = '2026-11-20T00:00:00Z'; return 1; });
    const r = await recover(codes[2]);
    expect(r.statusCode).toBe(401);
    expect(mockMinted).toEqual([]);
  });
});
