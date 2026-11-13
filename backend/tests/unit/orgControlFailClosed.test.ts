/**
 * B2 (e9 BLOCKING + Q2 ruling; e1 hunk list): orgControlService.preflightCheck fails CLOSED when it cannot read.
 * Before: loadControls error -> null -> { allowed: true } (an org auto-blocked for underfunding ran paid work), and
 * getCreditsUsedToday error -> 0 (the daily cap was bypassed). Now each is a retryable refusal:
 * ORG_CONTROLS_UNVERIFIABLE / DAILY_LIMIT_UNVERIFIABLE. Both failure shapes are covered: PostgREST's
 * { data: null, error } (resolves, never throws) and a thrown rejection (network / client error).
 */
type Res = { data: unknown; error: { message: string } | null };
type Mode = 'ok' | 'error' | 'throw';
const st: { controls: unknown; controlsMode: Mode; usage: unknown[]; usageMode: Mode; reads: string[] } = {
  controls: null, controlsMode: 'ok', usage: [], usageMode: 'ok', reads: [],
};
const answer = (mode: Mode, data: unknown): Promise<Res> => {
  if (mode === 'throw') return Promise.reject(new Error('socket hang up'));
  return Promise.resolve(mode === 'error' ? { data: null, error: { message: 'connection reset' } } : { data, error: null });
};

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    const b: any = {};
    for (const m of ['select', 'eq', 'not', 'gte', 'update', 'upsert', 'insert']) b[m] = () => b;
    b.maybeSingle = () => { st.reads.push(table); return answer(st.controlsMode, st.controls); };
    b.limit = () => { st.reads.push(table); return answer(st.usageMode, st.usage); };
    return b;
  },
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => { throw new Error('unexpected'); } } }));
jest.mock('../../services/alertService', () => ({ createAlert: async () => undefined }));

/* eslint-disable-next-line @typescript-eslint/no-var-requires */
const { preflightCheck, invalidateOrgControlsCache } = require('../../services/orgControlService');

const ORG = 'org-1';
beforeEach(() => {
  st.controls = null; st.controlsMode = 'ok'; st.usage = []; st.usageMode = 'ok'; st.reads = [];
  invalidateOrgControlsCache(ORG);
});

describe.each<[string, Mode]>([['an error object', 'error'], ['a thrown rejection', 'throw']])('the controls read fails with %s', (_n, mode) => {
  it('-> ORG_CONTROLS_UNVERIFIABLE, retryable (never "no controls -> allowed")', async () => {
    st.controlsMode = mode;
    const v = await preflightCheck(ORG, 10);
    expect(st.reads).toEqual(['org_controls']);                 // the read under test ran
    expect(v).toMatchObject({ allowed: false, code: 'ORG_CONTROLS_UNVERIFIABLE', retryable: true });
  });
  it('a failed read is NOT cached: the next readable answer is honoured', async () => {
    st.controlsMode = mode;
    await preflightCheck(ORG, 10);
    st.controlsMode = 'ok'; st.controls = { organization_id: ORG, is_blocked: true, blocked_reason: 'underfunded', is_high_risk: false, daily_credit_limit: null };
    await expect(preflightCheck(ORG, 10)).resolves.toMatchObject({ allowed: false, code: 'ORG_BLOCKED' });
  });
});

describe.each<[string, Mode]>([['an error object', 'error'], ['a thrown rejection', 'throw']])('the daily-usage read fails with %s', (_n, mode) => {
  it('-> DAILY_LIMIT_UNVERIFIABLE, retryable (never "0 used today")', async () => {
    st.controls = { organization_id: ORG, is_blocked: false, blocked_reason: null, is_high_risk: false, daily_credit_limit: 100 };
    st.usageMode = mode;
    const v = await preflightCheck(ORG, 10);
    expect(st.reads).toEqual(['org_controls', 'unified_transactions']);
    expect(v).toMatchObject({ allowed: false, code: 'DAILY_LIMIT_UNVERIFIABLE', retryable: true });
  });
});

describe('CONTROLS - healthy reads keep the existing verdicts', () => {
  it('a READ that finds no controls row -> allowed (a real absence)', async () => {
    await expect(preflightCheck(ORG, 10)).resolves.toEqual({ allowed: true });
  });
  it('a blocked org -> ORG_BLOCKED (not retryable)', async () => {
    st.controls = { organization_id: ORG, is_blocked: true, blocked_reason: 'underfunded', is_high_risk: false, daily_credit_limit: null };
    const v = await preflightCheck(ORG, 10);
    expect(v).toMatchObject({ allowed: false, code: 'ORG_BLOCKED' });
    expect(v).not.toHaveProperty('retryable');
  });
  it('usage readable: under the limit -> allowed; over -> DAILY_LIMIT_EXCEEDED', async () => {
    st.controls = { organization_id: ORG, is_blocked: false, blocked_reason: null, is_high_risk: false, daily_credit_limit: 100 };
    st.usage = [{ credits_charged: 80 }];
    await expect(preflightCheck(ORG, 10)).resolves.toEqual({ allowed: true });
    invalidateOrgControlsCache(ORG);
    await expect(preflightCheck(ORG, 30)).resolves.toMatchObject({ allowed: false, code: 'DAILY_LIMIT_EXCEEDED' });
  });
  it('the design comment no longer documents fail-open (source pin)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').resolve(__dirname, '../../services/orgControlService.ts'), 'utf8');
    expect(src).not.toMatch(/fail-open/i);
    expect(src).toMatch(/FAIL CLOSED \(e9 ruling/);
  });
});

describe('every retryable 503 refusal on this branch carries Retry-After (source pin)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs'); const path = require('path');
  const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8') as string;
  it.each([
    ['backend/services/activityWorkspace/contentRouteHandler.ts', /result\.status === 'state_unreadable'\) \{\s*res\.setHeader\('Retry-After'/],
    ['backend/services/activityWorkspace/contentRouteHandler.ts', /error\.statusCode === 503\) res\.setHeader\('Retry-After'/],
    ['pages/api/reports/generate.ts', /reservation\.status === 'state_unreadable'\) \{[\s\S]{0,200}?res\.setHeader\('Retry-After'/],
    ['pages/api/planner/generate-workspace-content.ts', /outcome\.httpStatus === 503\) res\.setHeader\('Retry-After'/],
    ['pages/api/admin/credits/idempotency/safe-retry.ts', /status === 503\) res\.setHeader\('Retry-After'/],
    ['pages/api/admin/credits/idempotency/recover.ts', /status === 503\) res\.setHeader\('Retry-After'/],
  ])('%s', (rel, re) => { expect(src(rel)).toMatch(re); });
});
