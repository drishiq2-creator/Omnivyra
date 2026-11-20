/**
 * Invitation replay may only re-send a LIVE invitation (b3/04 2026-11-20, correct-sending, BLOCKING).
 * Before: an enqueue failure REVOKED the fresh invitation; withIdempotency resumes a 5xx key, so the same-key retry
 * replayed the REVOKED row (findExistingByIdempotencyKey had no liveness check) and emailed a dead link.
 * REAL: invitationService (createAndSendInvitation / createInvitation). FAKED: the DB (in-memory invitations
 * honouring eq / is / maybeSingle / insert / update), enqueueEmailJob (recorded; can fail once).
 */
export {};
type Row = Record<string, any>;
const mockDb: Record<string, Row[]> = { invitations: [] };
function mockTable(table: string) {
  const tests: Array<(r: Row) => boolean> = [];
  let op = 'select';
  let payload: Row | null = null;
  const run = () => {
    const rows = (mockDb[table] ??= []);
    if (op === 'insert') {
      if (payload!.idempotency_key && rows.some((r) => r.idempotency_key === payload!.idempotency_key)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      const row = { id: `inv-${rows.length + 1}`, ...payload };
      rows.push(row);
      return { data: row, error: null };
    }
    const hit = rows.filter((r) => tests.every((t) => t(r)));
    if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null }; }
    return { data: hit[0] ?? null, error: null };
  };
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => { tests.push((r) => r[c] === v); return b; },
    is: (c: string, v: unknown) => { tests.push((r) => (r[c] ?? null) === v); return b; },
    lt: (c: string, v: string) => { tests.push((r) => typeof r[c] === 'string' && r[c] < v); return b; },
    insert: (p: Row) => { op = 'insert'; payload = p; return b; },
    update: (p: Row) => { op = 'update'; payload = p; return b; },
    maybeSingle: () => b,
    single: () => b,
    then: (ok: any, ko: any) => Promise.resolve(run()).then(ok, ko),
  };
  return b;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockTable(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockTable(t) } }));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockEnqueued: Array<Record<string, any>> = [];
let mockEnqueueFailOnce = false;
jest.mock('../../services/emailJobsService', () => ({
  enqueueEmailJob: async (job: Record<string, any>) => {
    if (mockEnqueueFailOnce) { mockEnqueueFailOnce = false; throw new Error('email_jobs insert failed'); }
    mockEnqueued.push(job);
    return { jobId: `job-${mockEnqueued.length}`, status: 'queued', replayed: false };
  },
}));

process.env.INVITATION_TOKEN_SECRET = 'test-only-invitation-signing-secret-0123456789abcdef';
/* eslint-disable @typescript-eslint/no-var-requires */
const svc = require('../../services/invitationService');

const INPUT = { email: 'pat@invitee.test', companyId: 'co-synthetic', role: 'CONTENT_CREATOR', invitedBy: 'admin-1' };
const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

beforeEach(() => { mockDb.invitations = []; mockDb.companies = []; mockDb.users = []; mockEnqueued.length = 0; mockEnqueueFailOnce = false; });

describe('an enqueue failure leaves the invitation LIVE, so the same-key retry sends a working link (once)', () => {
  it('first attempt: enqueue fails -> throws, the invitation is NOT revoked', async () => {
    mockEnqueueFailOnce = true;
    await expect(svc.createAndSendInvitation({ ...INPUT, idempotencyKey: 'k-1' })).rejects.toThrow(/email_jobs insert failed/);
    expect(mockDb.invitations).toHaveLength(1);
    expect(mockDb.invitations[0].revoked_at).toBeNull();
    expect(mockEnqueued).toEqual([]);
  });

  it('same-key retry: replays the live invitation and enqueues its email under the same email key', async () => {
    mockEnqueueFailOnce = true;
    await expect(svc.createAndSendInvitation({ ...INPUT, idempotencyKey: 'k-1' })).rejects.toThrow();
    const r = await svc.createAndSendInvitation({ ...INPUT, idempotencyKey: 'k-1' });
    expect(r).toMatchObject({ id: mockDb.invitations[0].id, replayed: true });
    expect(mockDb.invitations).toHaveLength(1); // no second invitation row
    expect(mockEnqueued).toHaveLength(1);
    expect(mockEnqueued[0]).toMatchObject({ idempotencyKey: 'k-1:email:magic_link', invitationId: mockDb.invitations[0].id });
    // the link is the LIVE row's token (hash matches)
    const token = new URL(mockEnqueued[0].payload.inviteUrl).searchParams.get('token');
    expect(svc.hashInvitationToken(token)).toBe(mockDb.invitations[0].token_hash);
  });
});

describe('a replay never re-sends an invitation that is no longer live', () => {
  const seedReplay = (over: Row) => {
    mockDb.invitations = [{ id: 'inv-old', email: INPUT.email, company_id: INPUT.companyId, idempotency_key: 'k-2', expires_at: FUTURE, revoked_at: null, accepted_at: null, token_consumed_at: null, ...over }];
  };
  it.each([
    ['revoked (superseded by a newer invitation)', { revoked_at: PAST }, 'revoked'],
    ['accepted', { accepted_at: PAST }, 'accepted'],
    ['token consumed', { token_consumed_at: PAST }, 'accepted'],
    ['expired', { expires_at: PAST }, 'expired'],
  ])('%s -> definitive 409 INVITATION_NOT_REPLAYABLE, nothing enqueued', async (_l, over, reason) => {
    seedReplay(over);
    const err = await svc.createAndSendInvitation({ ...INPUT, idempotencyKey: 'k-2' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(svc.InvitationNotReplayableError);
    expect(err).toMatchObject({ code: 'INVITATION_NOT_REPLAYABLE', statusCode: 409, retryable: false, reason });
    expect(mockEnqueued).toEqual([]);
  });

  it('control: a LIVE invitation replays and is (re)enqueued', async () => {
    seedReplay({});
    const r = await svc.createAndSendInvitation({ ...INPUT, idempotencyKey: 'k-2' });
    expect(r).toMatchObject({ id: 'inv-old', replayed: true });
    expect(mockEnqueued).toHaveLength(1);
  });
});
