/**
 * Reads contract (A2/A3, e1 follow-up 2): an UNREADABLE credit state did no work. Queue processors used to ignore the
 * result (bolt: `await ...; return`) or return { skipped } for every non-executed status, so BullMQ completed the job
 * as a SUCCESS and nothing retried it. Now 'state_unreadable' throws the typed retryable error; every other
 * non-executed status keeps its existing behaviour.
 * Behavioural on the real creator processor (billing seams faked); structural pin for every processor + the report
 * route (e1 follow-up 1: state_unreadable answered 409, now 503 retryable).
 */
import fs from 'fs';
import path from 'path';

const entry: { result: any; executorRuns: number } = { result: null, executorRuns: 0 };
const billing: { mode: string; flag: boolean; wrapped: any } = { mode: 'enforce', flag: false, wrapped: null };

jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => { throw new Error('no db in this test'); } } }));
jest.mock('../../services/creator/fanOutVisualVerdict', () => ({}));
jest.mock('../../services/unifiedContentGenerationEngine', () => ({}));
jest.mock('../../prompts/creatorContentPromptsV1', () => ({}));
jest.mock('../../services/creatorContentRepurposingEngine', () => ({}));
jest.mock('../../services/creatorContentValidation', () => ({}));
jest.mock('../../services/contentFeedbackLoop', () => ({}));
jest.mock('../../services/pricingService', () => ({}));
jest.mock('../../services/executionEngines/creatorExecutionEngine', () => ({}));
jest.mock('../../services/creator/creatorOrchestrator', () => ({}));
jest.mock('../../db/writeOwner', () => ({}));
jest.mock('../../../lib/shared/creatorGovernanceRegistry', () => ({ CREATOR_LIFECYCLE_STATES: {} }));
jest.mock('../../../lib/preview/previewUtils', () => ({}));
jest.mock('../../queue/jobProcessors/jobTenantBinding', () => ({
  assertJobCampaignBinding: async () => undefined, assertDailyPlanRowInCampaign: async () => undefined, assertPayloadCompaniesAgree: () => undefined,
}));
jest.mock('../../services/billing/creditEconomyShadow', () => ({ emitCreditEconomyShadowEvaluation: async () => undefined }));
jest.mock('../../services/billing/admissionControl', () => ({ evaluateActivityAdmission: async () => undefined }));
jest.mock('../../services/billing/billingFeatureFlags', () => ({ isBillingFlagEnabled: async () => ({ enabled: billing.flag }), BILLING_FLAGS: { RESERVATIONS_REQUIRED: 'x' } }));
jest.mock('../../services/billing/creditEconomyActivation', () => ({ getCreditEconomyExecutionMode: async () => billing.mode }));
jest.mock('../../services/billing/queueBillingMiddleware', () => ({ withQueueBilling: async () => billing.wrapped }));
jest.mock('../../services/creditExecutionService', () => ({
  makeIdempotencyKey: (...p: string[]) => p.join(':'),
  executeWithEntryConsumption: async () => entry.result,
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { processCreatorContentJob } = require('../../queue/jobProcessors/creatorContentProcessor');
const { CreditStateUnreadableError } = require('../../repositories/creditExecutionRepository');
/* eslint-enable @typescript-eslint/no-var-requires */

const job = { id: 'j-1', queueName: 'creator-content', data: { company_id: 'org-1', content_type: 'post', topic: 't', user_id: 'u-1' } } as any;

describe('creator processor - state_unreadable is retried, not completed', () => {
  it('state_unreadable -> throws the typed retryable error (BullMQ marks the attempt failed and retries)', async () => {
    entry.result = { status: 'state_unreadable', code: 'CREDIT_STATE_UNREADABLE', retryable: true, detail: 'lookup failed' };
    const p = processCreatorContentJob(job);
    await expect(p).rejects.toBeInstanceOf(CreditStateUnreadableError);
    await expect(p).rejects.toMatchObject({ code: 'CREDIT_STATE_UNREADABLE', retryable: true, message: 'lookup failed' });
  });
  it('CONTROL: insufficient_credits keeps the existing { skipped } completion', async () => {
    entry.result = { status: 'insufficient_credits' };
    await expect(processCreatorContentJob(job)).resolves.toEqual({ skipped: true, reason: 'insufficient_credits' });
  });
  it('CONTROL: executed returns the result', async () => {
    entry.result = { status: 'executed', result: { ok: 1 } };
    await expect(processCreatorContentJob(job)).resolves.toEqual({ ok: 1 });
  });
});

describe('creator processor - RESERVATIONS_REQUIRED flag path (withQueueBilling) - same rule', () => {
  beforeEach(() => { billing.mode = 'off'; billing.flag = true; });
  afterAll(() => { billing.mode = 'enforce'; billing.flag = false; });
  const orch = (result: any) => ({ kind: 'executed', orchestrator: { result } });
  it('orchestrator result state_unreadable -> throws the typed retryable error', async () => {
    billing.wrapped = orch({ status: 'state_unreadable', code: 'CREDIT_STATE_UNREADABLE', retryable: true, detail: 'hold read failed' });
    await expect(processCreatorContentJob(job)).rejects.toMatchObject({ name: 'CreditStateUnreadableError', code: 'CREDIT_STATE_UNREADABLE', retryable: true, message: 'hold read failed' });
  });
  it('CONTROL: insufficient_credits keeps { skipped }', async () => {
    billing.wrapped = orch({ status: 'insufficient_credits' });
    await expect(processCreatorContentJob(job)).resolves.toEqual({ skipped: true, reason: 'insufficient_credits' });
  });
  it('CONTROL: duplicate_blocked keeps { skipped }', async () => {
    billing.wrapped = { kind: 'duplicate_blocked', reason: 'replay', registryId: 'r1' };
    await expect(processCreatorContentJob(job)).resolves.toEqual({ skipped: true, reason: 'replay' });
  });
});

describe('every enforce-path consumer refuses state_unreadable (structural pin)', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const GUARD = /if \(r\.status === 'state_unreadable'\) \{[\s\S]{0,200}?throw new CreditStateUnreadableError\(r\.detail\)/;
  it.each([
    'backend/queue/jobProcessors/boltContentJobProcessor.ts',
    'backend/queue/jobProcessors/campaignPlanningProcessor.ts',
    'backend/queue/jobProcessors/contentGenerationProcessor.ts',
    'backend/queue/jobProcessors/creatorContentProcessor.ts',
  ])('%s throws before returning', (rel) => {
    const s = src(rel);
    const call = s.indexOf('= await executeWithEntryConsumption');
    expect(call).toBeGreaterThan(0);                 // the result is captured, not ignored
    const after = s.slice(call);
    const guard = after.search(GUARD);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(after.search(/\n\s*return\b/)); // before the first return after the call
  });
  it.each([
    'backend/queue/jobProcessors/boltContentJobProcessor.ts',
    'backend/queue/jobProcessors/campaignPlanningProcessor.ts',
    'backend/queue/jobProcessors/contentGenerationProcessor.ts',
    'backend/queue/jobProcessors/creatorContentProcessor.ts',
  ])('%s withQueueBilling path throws on state_unreadable', (rel) => {
    const s = src(rel);
    const call = s.indexOf('= await withQueueBilling(');
    expect(call).toBeGreaterThan(0);
    const after = s.slice(call);
    const end = after.search(/\n\}\n/);                     // the end of the enclosing processor function
    const guard = after.search(/wrapped\.orchestrator\.result\.status === 'state_unreadable'\) \{[\s\S]{0,200}?throw new CreditStateUnreadableError\(wrapped\.orchestrator\.result\.detail\)/);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(end);
  });
  it('reports/generate answers state_unreadable with 503 retryable BEFORE the generic 409 branch', () => {
    const s = src('pages/api/reports/generate.ts');
    const at = s.search(/if \(reservation\.status === 'state_unreadable'\) \{[\s\S]{0,300}?res\.status\(503\)[\s\S]{0,200}?retryable: true/);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(s.indexOf("reservation.status === 'no_credit_account' ? 402 : 409"));
  });
  it('POSITIVE CONTROL: the old bolt shape (result ignored) does not satisfy the pin', () => {
    const old = '    await executeWithEntryConsumption<void>({ executor });\n    return;';
    expect(old.indexOf('= await executeWithEntryConsumption')).toBe(-1);
  });
});
