/**
 * PI (c6 2026-11-20): every answer of POST /api/prospects/:id/enrich maps to plain words - and the client tables cover
 * EXACTLY the backend unions (both directions), so a new outcome or refusal cannot silently fall to a guess.
 */
import { describeEnrichResponse, OUTCOME_VIEW, REFUSAL_VIEW } from '../../../components/prospects/enrichOutcomeView';
import { ENRICHMENT_OUTCOMES } from '../../services/enrichment/providers/contract';
import { PLAN_REFUSALS } from '../../services/enrichment/execution';

const executed = (execution: Record<string, unknown>) => ({ status: 'executed', execution });

describe('union coverage - client tables == backend unions', () => {
  it('OUTCOME_VIEW covers exactly ENRICHMENT_OUTCOMES', () => {
    expect(Object.keys(OUTCOME_VIEW).sort()).toEqual([...ENRICHMENT_OUTCOMES].sort());
  });
  it('REFUSAL_VIEW covers exactly PLAN_REFUSALS', () => {
    expect(Object.keys(REFUSAL_VIEW).sort()).toEqual([...PLAN_REFUSALS].sort());
  });
  it.each([...ENRICHMENT_OUTCOMES])('outcome %s renders its own message', (o) => {
    expect(describeEnrichResponse(200, executed({ outcome: o, refusal: null }))).toEqual(OUTCOME_VIEW[o]);
  });
  it.each([...PLAN_REFUSALS])('refusal %s renders its own message', (r) => {
    expect(describeEnrichResponse(200, executed({ outcome: null, refusal: r }))).toEqual(REFUSAL_VIEW[r]);
  });
});

describe('success is claimed ONLY for enriched', () => {
  it('no other outcome or refusal is a success', () => {
    const successes = [
      ...Object.entries(OUTCOME_VIEW), ...Object.entries(REFUSAL_VIEW),
    ].filter(([, v]) => v.tone === 'success').map(([k]) => k);
    expect(successes).toEqual(['enriched']);
  });
});

describe('transport and route states', () => {
  it('no answer at all (network / lost response) -> unknown, never error', () => {
    expect(describeEnrichResponse(null, null).tone).toBe('unknown');
  });
  it('503 -> unknown (the run may or may not have happened)', () => {
    expect(describeEnrichResponse(503, { error: 'prospect_enrichment_unavailable', retryable: true }).tone).toBe('unknown');
  });
  it('403 -> admin-only message', () => {
    expect(describeEnrichResponse(403, { error: 'forbidden' }).message).toMatch(/Only company admins/);
  });
  it('401 / 404 have their own messages', () => {
    expect(describeEnrichResponse(401, {}).message).toMatch(/Sign in again/);
    expect(describeEnrichResponse(404, { error: 'prospect_not_found' }).message).toMatch(/not available in this company/);
  });
  it('200 not_planned -> info with the planner reason', () => {
    const v = describeEnrichResponse(200, { status: 'not_planned', reason: 'person.email is not in this plan' });
    expect(v.tone).toBe('info');
    expect(v.message).toContain('person.email is not in this plan');
  });
  it("the vendor's typed refusal shows the vendor's message (any status)", () => {
    const v = describeEnrichResponse(402, { error: 'Your Apollo plan does not include this endpoint', code: 'APOLLO_PLAN_INSUFFICIENT' });
    expect(v).toEqual({ tone: 'warning', message: 'Provider: Your Apollo plan does not include this endpoint' });
  });
  it('an outcome/refusal the client does not know -> unknown (never a guess)', () => {
    expect(describeEnrichResponse(200, executed({ outcome: 'some_future_outcome' })).tone).toBe('unknown');
    expect(describeEnrichResponse(200, executed({ refusal: 'some_future_refusal' })).tone).toBe('unknown');
    expect(describeEnrichResponse(200, { status: 'something_new' }).tone).toBe('unknown');
  });
});
