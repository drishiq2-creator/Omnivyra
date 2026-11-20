/**
 * The ONE definition of each company-profile AI endpoint's output fields (7c, 2026-11-19).
 *
 * The SERVER (the routes' mergeAiScalarFields) is the authoritative data-loss guard: it is the layer that
 * can actually lose data, so it owns what is protected. The client's merge (utils/mergeCampaignPurposeIntent
 * mergeNonEmptyFields) is advisory and reads the SAME lists, so the two layers can never protect different
 * fields. Pure module: safe for both the API routes and the browser bundle.
 */

/** Output fields of /api/company-profile/define-target-customer. */
export const TARGET_CUSTOMER_FIELDS = [
  'target_customer_segment',
  'ideal_customer_profile',
  'pricing_model',
  'sales_motion',
  'avg_deal_size',
  'sales_cycle',
  'key_metrics',
] as const;

/** Output fields of define-/generate-marketing-intelligence. */
export const MARKETING_INTELLIGENCE_FIELDS = [
  'marketing_channels',
  'content_strategy',
  'campaign_focus',
  'key_messages',
  'brand_positioning',
  'competitive_advantages',
  'growth_priorities',
] as const;
