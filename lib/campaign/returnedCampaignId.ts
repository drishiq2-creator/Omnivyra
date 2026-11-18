/**
 * Phase 1 of the deleted-campaign takeover fix (owner ruling 2026-11-18): adopt the server's
 * campaign_id; the server will mint it in phase 2. Changed by orchestration (89) under the
 * owner's ruling while no UI session was running.
 *
 * POST /api/campaigns/create-12week-plan answers with `campaign_id`, the id it actually used.
 * Every caller must continue (state, URL, refetch, navigation) with THAT id, not the one it
 * sent. A response without a usable `campaign_id` (an older server) keeps the sent id.
 */
export function resolveReturnedCampaignId(sentId: string, responseJson: unknown): string {
  if (responseJson && typeof responseJson === 'object') {
    const returned = (responseJson as { campaign_id?: unknown }).campaign_id;
    if (typeof returned === 'string' && returned.length > 0) return returned;
  }
  return sentId;
}
