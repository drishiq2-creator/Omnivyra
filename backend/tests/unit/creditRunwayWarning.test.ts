/**
 * 3-day runway warning (owner promise 2026-11-14; b3 spec 2026-11-20; c6). runway_days = balance / (burn7 / 7), burn7 =
 * trailing 7-day SETTLED consumption (confirm + confirm_partial). Warns (in-app + admin email) when balance > 0,
 * burn7 > 0 and runway <= 3; 72h dedup; a top-up re-arms; the daily sweep reaches scheduled-only spenders; a read
 * failure sends nothing (never a false "you're fine", never a duplicate).
 */
type Row = Record<string, any>;
const db: { balance: Row | null; balanceErr: boolean; tx: Row[]; txErr: boolean; log: Row[]; logErr: boolean; notifications: Row[] } =
  { balance: null, balanceErr: false, tx: [], txErr: false, log: [], logErr: false, notifications: [] };
const mockRunwayEmail = jest.fn(async () => undefined);

function chain(table: string): any {
  const f: Record<string, any> = {};
  const q: any = {};
  q.select = () => q;
  q.eq = (c: string, v: unknown) => { f[c] = v; return q; };
  q.in = (c: string, v: unknown[]) => { f[`${c}__in`] = v; return q; };
  q.gte = () => q; q.order = () => q; q.limit = () => q;
  q.insert = async (row: Row) => {
    if (table === 'credit_alert_log') db.log.push({ ...row });
    if (table === 'notifications') db.notifications.push({ ...row });
    return { error: null };
  };
  q.maybeSingle = async () => {
    if (table === 'organization_credits') return db.balanceErr ? { data: null, error: { message: 'down' } } : { data: db.balance, error: null };
    if (table === 'users') return { data: { email: 'admin@acme.test' }, error: null };
    if (table === 'companies') return { data: { name: 'Acme' }, error: null };
    return { data: null, error: null };
  };
  q.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => {
    let res: unknown = { data: [], error: null };
    if (table === 'credit_transactions') {
      const phases = f['execution_phase__in'] as string[] | undefined;
      res = db.txErr ? { data: null, error: { message: 'down' } }
        : { data: db.tx.filter((r) => (!f.organization_id || r.organization_id === f.organization_id) && (!phases || phases.includes(r.execution_phase))), error: null };
    }
    if (table === 'credit_alert_log') {
      const types = f['alert_type__in'] as string[] | undefined;
      res = db.logErr ? { data: null, error: { message: 'down' } }
        : { data: db.log.filter((r) => r.organization_id === f.organization_id && (!types || types.includes(r.alert_type)))
            .sort((a, b) => String(b.notified_at).localeCompare(String(a.notified_at))), error: null };
    }
    if (table === 'user_company_roles') res = { data: [{ user_id: 'u-admin', role: 'COMPANY_ADMIN', created_at: '1' }], error: null };
    return Promise.resolve(res).then(ok, err);
  };
  return q;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => chain(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => chain(t) } }));
jest.mock('../../services/emailService', () => ({ sendCreditRunwayAlert: (...a: unknown[]) => mockRunwayEmail(...(a as [])), sendCreditAlert: jest.fn() }));

import { evaluateRunwayWarning, runCreditRunwaySweep, runwayDays } from '../../services/creditAlertService';

const ORG = 'org-1';
/** 7 days at `perDay` credits/day, as settled rows of the given phase. */
const burn = (perDay: number, phase = 'confirm', org = ORG) => Array.from({ length: 7 }, () =>
  ({ organization_id: org, execution_phase: phase, free_delta: -perDay, paid_delta: 0, incentive_delta: 0, credits_delta: -perDay }));
const setBalance = (n: number) => { db.balance = { free_balance: n, paid_balance: 0, incentive_balance: 0 }; };

beforeEach(() => {
  db.balance = null; db.balanceErr = false; db.tx = []; db.txErr = false; db.log = []; db.logErr = false; db.notifications = [];
  mockRunwayEmail.mockClear();
});

test('runwayDays: balance / (burn7 / 7); no burn or no balance -> null', () => {
  expect(runwayDays(150, 420)).toBeCloseTo(2.5, 10);
  expect(runwayDays(150, 0)).toBeNull();
  expect(runwayDays(0, 420)).toBeNull();
});

test('150 credits at 60/day (runway 2.5 days) -> warns in-app AND emails the admin, once', async () => {
  setBalance(150); db.tx = burn(60);
  expect(await evaluateRunwayWarning(ORG)).toBe('warned');
  expect(db.log.map((r) => r.alert_type)).toEqual(['runway_3d']);
  expect(db.notifications).toHaveLength(1);
  expect(String(db.notifications[0].message)).toMatch(/run out in about 3 days/);
  expect(mockRunwayEmail).toHaveBeenCalledWith(expect.objectContaining({ recipientEmail: 'admin@acme.test', companyName: 'Acme', runwayDays: 3, remainingCredits: 150 }), expect.any(String));
  // 72h dedup: a second evaluation does not warn again
  expect(await evaluateRunwayWarning(ORG)).toBe('none');
  expect(db.notifications).toHaveLength(1);
});

test('1000 credits at 60/day (runway ~16.7 days) -> silent', async () => {
  setBalance(1000); db.tx = burn(60);
  expect(await evaluateRunwayWarning(ORG)).toBe('none');
  expect(db.log).toEqual([]);
  expect(mockRunwayEmail).not.toHaveBeenCalled();
});

test('a top-up re-arms: warn -> top-up clears -> the next breach warns again inside 72h', async () => {
  // Real evaluations are at least seconds apart; advance the clock so the log's notified_at orders them.
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  const now = { mockReturnValue: (t: number) => jest.setSystemTime(t) };
  try {
    setBalance(150); db.tx = burn(60);
    now.mockReturnValue(t0);
    expect(await evaluateRunwayWarning(ORG)).toBe('warned');
    setBalance(1000);
    now.mockReturnValue(t0 + 3600_000);            // 1h later: topped up
    expect(await evaluateRunwayWarning(ORG)).toBe('cleared');
    setBalance(140);
    now.mockReturnValue(t0 + 7200_000);            // 2h later - still inside the 72h window
    expect(await evaluateRunwayWarning(ORG)).toBe('warned');
    expect(db.log.map((r) => r.alert_type)).toEqual(['runway_3d', 'runway_3d_cleared', 'runway_3d']);
  } finally {
    jest.useRealTimers();
  }
});

test('control: WITHOUT a top-up, a second breach inside 72h is deduplicated', async () => {
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  const now = { mockReturnValue: (t: number) => jest.setSystemTime(t) };
  try {
    setBalance(150); db.tx = burn(60);
    now.mockReturnValue(t0);
    expect(await evaluateRunwayWarning(ORG)).toBe('warned');
    now.mockReturnValue(t0 + 7200_000);
    expect(await evaluateRunwayWarning(ORG)).toBe('none');
    now.mockReturnValue(t0 + 73 * 3600_000);       // past 72h -> warns again
    expect(await evaluateRunwayWarning(ORG)).toBe('warned');
  } finally {
    jest.useRealTimers();
  }
});

test('a confirm_partial-ONLY burn counts (a confirm-only reader would see 0 burn and stay silent)', async () => {
  setBalance(150); db.tx = burn(60, 'confirm_partial');
  expect(await evaluateRunwayWarning(ORG)).toBe('warned');
});

test('the daily sweep evaluates a scheduled-only spender (no interactive path) and warns it', async () => {
  setBalance(150); db.tx = burn(60, 'confirm_partial', ORG);
  const r = await runCreditRunwaySweep();
  expect(r).toEqual({ evaluated: 1, warned: 1 });
});

test.each([
  ['the balance read fails', () => { db.balanceErr = true; }],
  ['the consumption read fails', () => { db.txErr = true; }],
  ['the alert-log read fails', () => { db.logErr = true; }],
])('%s -> NOTHING sent (unreadable), never a false "fine" and never a duplicate', async (_n, arrange) => {
  setBalance(150); db.tx = burn(60);
  arrange();
  expect(await evaluateRunwayWarning(ORG)).toBe('unreadable');
  expect(db.notifications).toEqual([]);
  expect(mockRunwayEmail).not.toHaveBeenCalled();
});

test('the sweep fails LOUDLY when it cannot read which orgs spent (never "nobody to warn")', async () => {
  db.txErr = true;
  await expect(runCreditRunwaySweep()).rejects.toThrow(/runway sweep org read failed/);
});
