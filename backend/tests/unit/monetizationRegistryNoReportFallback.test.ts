/**
 * BLOCKING money fix (b3/c6 2026-11-20): resolveMonetizationFeature used the REPORT fallback even when no report
 * field was given; resolveFeatureFromReport treats absent fields as matches, so it returned the first entry with a
 * report mapping (website_audit) and getCreditCost priced every CreditAction WITHOUT a registry entry as a website
 * audit. REAL: featureRegistry, getCreditCost, CREDIT_ACTIONS. FAKED: the credit_cost_config read (records the key).
 */
export {};
const mockKeys: string[] = [];
jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: () => ({ select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => { mockKeys.push(key); return { data: { credits: 7 }, error: null }; } }) }) }) },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { resolveMonetizationFeature, resolveFeatureFromActionKey } = require('../../../shared/monetization/featureRegistry');
const { CREDIT_ACTIONS, getCreditCost } = require('../../services/creditDeductionService');

/**
 * RATCHET: CreditActions that have NO registry entry today. Each must price from its OWN credit_cost_config row and
 * fails CLOSED in executeWithCredits until c6 adds its entry. REMOVE an action from this list when its entry lands;
 * the test fails if the list is not exactly the unmapped set (a new unmapped action, or a stale name).
 */
const KNOWN_UNMAPPED: string[] = []; // all 21 got entries (c6 shape, 2026-11-20) - keep it EMPTY

beforeEach(() => { mockKeys.length = 0; });

describe('no report fallback without report fields', () => {
  it('an UNKNOWN action resolves to null (fails closed), never to another product', () => {
    expect(resolveMonetizationFeature({ action_key: 'zz_unknown_action_test' })).toBeNull();
    expect(resolveMonetizationFeature({})).toBeNull();
  });

  it('EVERY CreditAction has exactly ONE entry, priced from its OWN key (credit_cost_config = the action; no token path)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MONETIZATION_FEATURE_REGISTRY } = require('../../../shared/monetization/featureRegistry');
    for (const a of CREDIT_ACTIONS as string[]) {
      const owners = (MONETIZATION_FEATURE_REGISTRY as any[]).filter((e) => e.pricing_keys?.action_key === a);
      expect({ a, owners: owners.length }).toEqual({ a, owners: 1 });
      expect({ a, key: resolveMonetizationFeature({ action_key: a })?.feature.pricing_keys.credit_cost_config ?? a }).toEqual({ a, key: a });
    }
  });

  it('REVERSE (7c NB3): every registry entry that names an action_key names a real CreditAction (closes the union both ways)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MONETIZATION_FEATURE_REGISTRY } = require('../../../shared/monetization/featureRegistry');
    const actions = new Set(CREDIT_ACTIONS as string[]);
    // An entry whose action_key is NOT a CreditAction is legitimate ONLY as an internal, TOKEN-priced operation
    // (internal_only + action_pricing_config, and NO credit_cost_config): today external_api, embedding,
    // blogAnalyticsInsight, profile_enrichment, profile_extraction. Keyed on SHAPE, not names, so a new stray that
    // claims a fixed credit price, or is user-facing, fails here.
    const nonActions = (MONETIZATION_FEATURE_REGISTRY as any[]).filter(
      (e) => typeof e.pricing_keys?.action_key === 'string' && !actions.has(e.pricing_keys.action_key));
    const misshapen = nonActions
      .filter((e) => !(e.internal_only === true && e.pricing_keys.action_pricing_config && !e.pricing_keys.credit_cost_config))
      .map((e) => e.pricing_keys.action_key);
    expect(misshapen).toEqual([]);
    // Control: the shape rule is not vacuous; these internal token-priced entries exist and pass it.
    expect(nonActions.length).toBeGreaterThan(0);
  });

  it('the month-plan gateway calls are attributed to the PLAN job, not the autonomous campaign agent (c6)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveFeatureFromProcessType } = require('../../../shared/monetization/featureRegistry');
    expect(resolveFeatureFromProcessType('generateCampaignPlan')?.pricing_keys.action_key).toBe('async_campaign_planning');
    expect(resolveFeatureFromProcessType('parsePlanToWeeks')?.pricing_keys.action_key).toBe('async_campaign_planning');
  });

  it('getCreditCost prices each formerly-unmapped action from its OWN row - never website_audit', async () => {
    await getCreditCost('blog_brief_suggestions');
    await getCreditCost('recommendations_generate');
    await getCreditCost('async_campaign_planning');
    expect(mockKeys).toEqual(['blog_brief_suggestions', 'recommendations_generate', 'async_campaign_planning']);
  });

  it('CONTROL: a REPORT lookup still resolves through the report fallback', () => {
    // real mappings (featureRegistry.ts:93-96, :120-123): snapshot/content_readiness, performance/performance_intelligence
    expect(resolveMonetizationFeature({ report_category: 'snapshot' })?.feature.report_type_mapping?.report_type).toBe('content_readiness');
    expect(resolveMonetizationFeature({ report_category: 'performance' })?.feature.report_type_mapping?.report_type).toBe('performance_intelligence');
  });

  it('UNION RATCHET: the unmapped CreditActions are exactly KNOWN_UNMAPPED; every mapped one resolves by its own action key', () => {
    const unmapped = (CREDIT_ACTIONS as string[]).filter((a) => !resolveFeatureFromActionKey(a)).sort();
    expect(unmapped).toEqual([...KNOWN_UNMAPPED].sort());
    for (const a of CREDIT_ACTIONS as string[]) {
      const r = resolveMonetizationFeature({ action_key: a });
      if (KNOWN_UNMAPPED.includes(a)) expect(r).toBeNull();
      else expect(r?.feature_key).toBeTruthy(); // a MAPPED action resolves through its OWN entry (by action key)
    }
  });
});
