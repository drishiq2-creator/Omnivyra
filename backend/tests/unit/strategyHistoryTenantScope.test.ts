/**
 * strategyHistoryService (b3 2026-11-20, BLOCKING cross-tenant read): campaign snapshots store a client-supplied
 * recommendation_id unvalidated, and the history read resolved those ids against recommendation_snapshots by id
 * ALONE - surfacing ANOTHER company's trend_topic / category in this company's strategy history.
 * FAKED: the DB (in-memory rows honouring eq / in / order). REAL: getStrategyHistoryForCompany.
 */
export {};
type Row = Record<string, any>;
const mockDb: Record<string, Row[]> = {};
function mockTable(table: string) {
  const tests: Array<(r: Row) => boolean> = [];
  const b: any = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: unknown) => { tests.push((r) => r[c] === v); return b; },
    in: (c: string, v: unknown[]) => { tests.push((r) => v.includes(r[c])); return b; },
    then: (ok: any, ko: any) => Promise.resolve({ data: (mockDb[table] ?? []).filter((r) => tests.every((t) => t(r))), error: null }).then(ok, ko),
  };
  return b;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => mockTable(t) } }));
jest.mock('@/backend/services/context/canonicalProfileAdapter', () => ({ getCanonicalProfile: async () => null }));

/* eslint-disable @typescript-eslint/no-var-requires */
const { getStrategyHistoryForCompany } = require('../../services/strategyHistoryService');

const CO_A = 'co-a-synthetic';
const CO_B = 'co-b-synthetic';
const REC_A = 'rec-a-synthetic';
const REC_B = 'rec-b-synthetic';

beforeEach(() => {
  mockDb.recommendation_snapshots = [
    { id: REC_A, company_id: CO_A, trend_topic: 'A secret topic', category: 'A Confidential Category' },
    { id: REC_B, company_id: CO_B, trend_topic: 'B topic', category: 'B Category' },
  ];
});

const campaignOf = (company: string, recId: string) =>
  ({ company_id: company, created_at: '2026-11-01T00:00:00Z', campaign_snapshot: { source_recommendation_id: recId } });

describe('strategy history resolves recommendation ids only within the company', () => {
  it('a campaign of B carrying company A\'s recommendation id never surfaces A\'s category or topic', async () => {
    mockDb.campaign_versions = [campaignOf(CO_B, REC_A)];
    const r = await getStrategyHistoryForCompany(CO_B);
    expect(r.campaigns_count).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/A Confidential Category|A secret topic/);
  });

  it('control: B\'s own recommendation id resolves to its category', async () => {
    mockDb.campaign_versions = [campaignOf(CO_B, REC_B)];
    const r = await getStrategyHistoryForCompany(CO_B);
    expect(JSON.stringify(r)).toMatch(/B Category/);
  });
});
