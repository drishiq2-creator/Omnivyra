/**
 * b3 ruling 2026-11-18 (the "ignored write" group): a charge is for a work product that was SAVED. These paths saved
 * first but ignored a failed write (supabase reports failure as { error } - it does not throw - so the old try/catch
 * never saw it) and charged anyway.
 *   - portfolioDecisionEngine (behavioural): insert { error } or a throw -> NO deduction; a saved decision -> one.
 *   - strategyEvolutionEngine, campaignPlanningProcessor, boltContentJobProcessor: source pins (their full pipelines are
 *     integration-scale; each fix is a single guarded line pinned here).
 */
import * as fs from 'fs';
import * as path from 'path';

let mockInsertResult: { error: { message: string } | null } | Error = { error: null };
const mockDeduct = jest.fn(async () => undefined);
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (_t: string) => ({ insert: async () => { if (mockInsertResult instanceof Error) throw mockInsertResult; return mockInsertResult; } }),
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: {} }));
jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../services/normalizePortfolioInputsService', () => ({
  loadNormalizedPortfolioInputs: async () => [{ campaign_id: 'c1', campaign_name: 'One' }, { campaign_id: 'c2', campaign_name: 'Two' }],
}));
jest.mock('../../services/autonomousCampaignAgent', () => ({ getAutonomousSettings: async () => ({ risk_tolerance: 'balanced' }) }));
jest.mock('../../services/performanceFeedbackService', () => ({ aggregateCampaignPerformance: async () => ({ engagement_rate: 0.05 }) }));
jest.mock('../../services/campaignDecisionEngine', () => ({ evaluateCampaignDecision: async () => ({ action: 'OPTIMIZE' }) }));
jest.mock('../../services/autonomousDecisionLogger', () => ({ logDecision: async () => undefined }));
jest.mock('../../services/creditExecutionService', () => ({ deductCreditsAwaited: (...a: unknown[]) => mockDeduct(...(a as [])) }));
jest.mock('../../services/decisionObjectService', () => ({ archiveDecisionScope: jest.fn(), createDecisionObjects: jest.fn() }));

import { evaluatePortfolioDecision } from '../../services/portfolioDecisionEngine';

beforeEach(() => { mockDeduct.mockClear(); mockInsertResult = { error: null }; });

describe('portfolio decision: charged only when the decision is saved', () => {
  test('a saved decision -> one deduction', async () => {
    expect(await evaluatePortfolioDecision('org-1')).not.toBeNull();
    expect(mockDeduct).toHaveBeenCalledTimes(1);
  });
  test('the insert returns { error } (supabase does not throw) -> the decision is still returned, NO deduction', async () => {
    mockInsertResult = { error: { message: 'permission denied' } };
    expect(await evaluatePortfolioDecision('org-1')).not.toBeNull();
    expect(mockDeduct).not.toHaveBeenCalled();
  });
  test('the insert throws -> NO deduction', async () => {
    mockInsertResult = new Error('fetch failed');
    await evaluatePortfolioDecision('org-1');
    expect(mockDeduct).not.toHaveBeenCalled();
  });
});

describe('the other ignored-write sites (pins)', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  test('strategyEvolutionEngine: the insert error is checked and the deduction is gated on persisted', () => {
    const s = read('backend/services/strategyEvolutionEngine.ts');
    expect(s).toMatch(/const \{ data: log, error: logErr \} = await ownedDbTable\('strategy_evolution_log'\)/);
    expect(s).toMatch(/if \(logErr\) throw new Error\(logErr\.message\);/);
    expect(s).toMatch(/deductCreditsIfValueAwaited\(companyId, 'strategy_evolution', persisted && changes\.length > 0/);
  });
  test('campaignPlanningProcessor: a failed plan upsert THROWS inside the billed executor (charge released)', () => {
    const s = read('backend/queue/jobProcessors/campaignPlanningProcessor.ts');
    expect(s).toMatch(/const \{ error: persistErr \} = await supabase\.from\('campaign_week_plan'\)\.upsert\(/);
    expect(s).toMatch(/if \(persistErr\) throw new Error/);
  });
  test('boltContentJobProcessor: when EVERY write failed (nothing delivered) it throws; partial delivery is still charged', () => {
    const s = read('backend/queue/jobProcessors/boltContentJobProcessor.ts');
    expect(s).toMatch(/insertFailed\+\+;/);
    expect(s).toMatch(/if \(scheduled === 0 && insertFailed > 0\) \{\s*throw new Error/);
  });
});
