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
const KNOWN_UNMAPPED = [
  'async_campaign_planning', 'blog_brief_suggestions', 'blog_generation', 'blog_rewrite_hook', 'campaign_chat',
  'campaign_preplanning', 'campaign_suggest_duration', 'campaign_suggest_update', 'chat_theme_refine',
  'content_repurpose', 'content_suggestions', 'creator_content', 'engagement_refine', 'image_generation',
  'quick_platform_adapt', 'recommendations_generate', 'recommendations_group_preview',
  'recommendations_opportunities', 'recommendations_preview_strategy', 'skeleton_command', 'video_generation',
];

beforeEach(() => { mockKeys.length = 0; });

describe('no report fallback without report fields', () => {
  it('an action with NO registry entry resolves to null (fails closed), never to another product', () => {
    expect(resolveMonetizationFeature({ action_key: 'blog_brief_suggestions' })).toBeNull();
    expect(resolveMonetizationFeature({})).toBeNull();
  });

  it('getCreditCost prices an unmapped action from its OWN row - never website_audit', async () => {
    await getCreditCost('blog_brief_suggestions');
    await getCreditCost('recommendations_generate');
    expect(mockKeys).toEqual(['blog_brief_suggestions', 'recommendations_generate']);
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
