/**
 * Phase 1 of the deleted-campaign takeover fix (owner ruling 2026-11-18): adopt the server's
 * campaign_id; the server will mint it in phase 2. Changed by orchestration (89) under the
 * owner's ruling while no UI session was running.
 *
 * POST /api/campaigns/create-12week-plan answers with `campaign_id`, the id it actually used.
 * Every caller must continue (state, URL, refetch, navigation) with THAT id, not the one it
 * sent. A response without a usable `campaign_id` (an older server) keeps the sent id.
 */
// 7c review: the adoption point accepts ONLY a well-formed uuid - the same shape create-12week-plan validates
// server-side. Phase 2 is when the server starts returning a different id; an unvalidated value here would flow into
// the URL and the navigation target. Anything else keeps the sent id (the documented old-server behaviour).
const CAMPAIGN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveReturnedCampaignId(sentId: string, responseJson: unknown): string {
  if (responseJson && typeof responseJson === 'object') {
    const returned = (responseJson as { campaign_id?: unknown }).campaign_id;
    if (typeof returned === 'string' && CAMPAIGN_ID_SHAPE.test(returned)) return returned;
  }
  return sentId;
}
