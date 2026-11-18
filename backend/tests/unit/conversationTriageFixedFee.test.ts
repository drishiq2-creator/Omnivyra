/**
 * OWNER 2026-11-18: conversation triage is a FIXED 1 credit per classified conversation (7c: make the ruling
 * self-defending). The catalog resolves it as a flat fee from credit_cost_config - never token-priced - and the worker
 * charges exactly TRIAGE_CREDITS_PER_CONVERSATION = 1.
 */
const reads: string[] = [];
function b(table: string) {
  const x: any = {};
  for (const m of ['select', 'eq', 'lte', 'order', 'limit']) x[m] = () => x;
  x.maybeSingle = async () => {
    reads.push(table);
    if (table === 'credit_cost_config') return { data: { credits: 1 }, error: null };
    if (table === 'organization_credits') return { data: { credit_rate_usd: 0.001 }, error: null };
    return { data: null, error: null };   // action_pricing_config: no row (056 pins its absence)
  };
  return x;
}
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: (t: string) => b(t) } }));
jest.mock('../../db/writeOwner', () => ({ ownedDbTable: (t: string) => b(t) }));

import { resolveActivityCreditRange } from '../../services/pricingService';
import { TRIAGE_CREDITS_PER_CONVERSATION } from '../../workers/conversationTriageWorker';

test('conversation_triage previews as a FLAT 1 credit (not token-priced), even at the legacy 0.001 rate', async () => {
  const r = await resolveActivityCreditRange('conversation_triage', '11111111-1111-4111-8111-111111111111');
  expect(r).toMatchObject({ minCredits: 1, maxCredits: 1, expectedCredits: 1, tokenPriced: false, source: 'credit_cost_config' });
  expect(reads).toContain('action_pricing_config');   // the token-priced path was consulted and found nothing
});

test('the worker charges exactly 1 credit per classified conversation', () => {
  expect(TRIAGE_CREDITS_PER_CONVERSATION).toBe(1);
});
