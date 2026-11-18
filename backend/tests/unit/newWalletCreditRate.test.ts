/**
 * OWNER ruling 2026-11-18 (via b3): a NEW signup wallet starts at credit_rate_usd 0.007 (was a stray 0.001 literal).
 * The value comes from the ONE shared constant; existing wallets are untouched (ignoreDuplicates).
 */
export {};
type Row = Record<string, any>;
const mockDb: Record<string, Row[]> = {};
const mockWrites: Array<{ table: string; op: string; row: Row }> = [];
const mockCredits: Row[] = [];
const upsertOpts: Array<{ table: string; opts?: Row }> = [];
function mockTable(table: string) {
  const tests: Array<(r: Row) => boolean> = []; let one = false; let op = 'select'; let payload: Row = {};
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => { tests.push((r) => r[c] === v); return b; },
    is: (c: string, v: unknown) => { tests.push((r) => (r[c] ?? null) === v); return b; },
    insert: (p: Row) => { op = 'insert'; payload = p; return b; },
    upsert: (p: Row, opts?: Row) => { op = 'upsert'; payload = p; upsertOpts.push({ table, opts }); return b; },
    update: (p: Row) => { op = 'update'; payload = p; return b; },
    maybeSingle: () => { one = true; return b; },
    then: (ok: any, ko: any) => {
      const rows = (mockDb[table] ??= []);
      if (op !== 'select') {
        mockWrites.push({ table, op, row: payload });
        if (op === 'insert') rows.push({ ...payload });
        if (op === 'update') rows.filter((r) => tests.every((t) => t(r))).forEach((r) => Object.assign(r, payload));
        return Promise.resolve({ data: null, error: null }).then(ok, ko);
      }
      const hit = rows.filter((r) => tests.every((t) => t(r)));
      return Promise.resolve({ data: one ? hit[0] ?? null : hit, error: null }).then(ok, ko);
    },
  };
  return b;
}
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => mockTable(t) }));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockTable(t) } }));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../services/creditExecutionService', () => ({
  makeIdempotencyKey: (...parts: string[]) => `idem:${parts.join(':')}`,
  createCredit: async (input: Row) => { mockCredits.push(input); },
}));
/* eslint-disable @typescript-eslint/no-var-requires */
const { grantInitialFreeCredit } = require('../../services/initialFreeCreditService');
/* eslint-enable @typescript-eslint/no-var-requires */
const ORG = '11111111-1111-4111-8111-111111111111';
const KEY = `idem:${ORG}:initial_free_credit:${ORG}`;
beforeEach(() => {
  for (const k of Object.keys(mockDb)) delete mockDb[k];
  mockWrites.length = 0; mockCredits.length = 0; upsertOpts.length = 0;
  mockDb.free_credit_config = [{ category: 'initial_free_credit', credits: 300, expiry_days: 30, is_active: true }];
  mockDb.companies = [{ id: ORG, free_credit_granted_at: null }];
  mockDb.free_credit_claims = [];
  mockDb.credit_transactions = [];
});

import { NEW_WALLET_CREDIT_RATE_USD } from '../../../shared/billing/newWalletCreditRate';

it('the constant is the owner rate 0.007', () => {
  expect(NEW_WALLET_CREDIT_RATE_USD).toBe(0.007);
});

it('a fresh onboarding grant creates the wallet at 0.007 (and only inserts; an existing wallet is not rewritten)', async () => {
  const r = await grantInitialFreeCredit({ orgId: ORG, userId: 'u1', emailDomain: 'acme.com' });
  expect(r.granted).toBe(true);
  const wallet = mockWrites.filter((w) => w.table === 'organization_credits');
  expect(wallet).toHaveLength(1);
  expect(wallet[0]).toMatchObject({ op: 'upsert', row: { organization_id: ORG, credit_rate_usd: 0.007 } });
});

it('no source file still writes the 0.001 literal as a wallet rate', () => {
  const fs = require('fs'); const path = require('path');
  const s = fs.readFileSync(path.join(process.cwd(), 'backend/services/initialFreeCreditService.ts'), 'utf8');
  expect(s).not.toMatch(/credit_rate_usd:\s*0\.001/);
  expect(s).toMatch(/credit_rate_usd:\s*NEW_WALLET_CREDIT_RATE_USD/);
});

it('b3 pin: the signup upsert is INSERT-ONLY (onConflict organization_id, ignoreDuplicates) - the rate of an existing wallet is never overwritten', async () => {
  await grantInitialFreeCredit({ orgId: ORG, userId: 'u1', emailDomain: 'acme.com' });
  const w = upsertOpts.filter((u) => u.table === 'organization_credits');
  expect(w).toEqual([{ table: 'organization_credits', opts: { onConflict: 'organization_id', ignoreDuplicates: true } }]);
});
