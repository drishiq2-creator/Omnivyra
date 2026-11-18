import { supabase } from './supabaseClient';
import { resolveCampaignOwnership } from '../services/campaignOwnershipService';

/**
 * S2-55 (2026-11-14): content_assets has no company column (campaign_id is text, no FK to campaigns), the request
 * gate allows a campaign id that matches NO campaign, and assets of a deleted campaign survive. So a list keyed on
 * campaign_id alone can return another company's orphaned assets. When the caller passes the AUTHORIZED companyId,
 * the campaign must first be proven that company's own by the canonical resolver (campaigns.company_id plus every
 * campaign_versions row agree on it); otherwise nothing is read. A failed owner lookup throws (fail closed: never
 * "unknown, so read").
 */
async function campaignOwnedByCompany(campaignId: string, companyId: string): Promise<boolean> {
  const ownership = await resolveCampaignOwnership(campaignId);
  if (ownership.status === 'LOOKUP_FAILED') {
    throw new Error('Campaign ownership check is temporarily unavailable');
  }
  return ownership.status === 'OWNED' && ownership.companyId.toLowerCase() === String(companyId).toLowerCase();
}

export async function createContentAsset(input: {
  campaignId: string;
  weekNumber: number;
  day: string;
  platform: string;
  // Optional caller-supplied primary key. When provided we insert this exact
  // UUID instead of letting the DB default generate one — this lets a caller
  // know the asset_id BEFORE the row exists (e.g. to mint a tracking link that
  // carries omn_asset_id). When omitted, behaviour is identical to before
  // (gen_random_uuid() default fills asset_id).
  assetId?: string | null;
}): Promise<any> {
  const payload: Record<string, unknown> = {
    campaign_id: input.campaignId,
    week_number: input.weekNumber,
    day: input.day,
    platform: input.platform,
    status: 'draft',
    current_version: 1,
    created_at: new Date().toISOString(),
  };
  if (input.assetId) payload.asset_id = input.assetId;
  const { data, error } = await supabase
    .from('content_assets')
    .insert(payload)
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to create content asset: ${error.message}`);
  }
  return data;
}

export async function getContentAssetByKey(input: {
  campaignId: string;
  weekNumber: number;
  day: string;
  platform: string;
}): Promise<any | null> {
  const { data, error } = await supabase
    .from('content_assets')
    .select('*')
    .eq('campaign_id', input.campaignId)
    .eq('week_number', input.weekNumber)
    .eq('day', input.day)
    .eq('platform', input.platform)
    .limit(1)
    .single();
  if (error) {
    return null;
  }
  return data;
}

export async function getContentAssetById(assetId: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('content_assets')
    .select('*')
    .eq('asset_id', assetId)
    .single();
  if (error) return null;
  return data;
}

export async function listContentAssets(input: {
  campaignId: string;
  weekNumber?: number;
  /** S2-55: the authorized company; when given, a campaign that is not its own lists nothing. */
  companyId?: string;
}): Promise<any[]> {
  if (input.companyId !== undefined && !(await campaignOwnedByCompany(input.campaignId, input.companyId))) return [];
  let query = supabase.from('content_assets').select('*').eq('campaign_id', input.campaignId);
  if (input.weekNumber) {
    query = query.eq('week_number', input.weekNumber);
  }
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error || !data) return [];
  return data;
}

export async function createContentVersion(input: {
  assetId: string;
  version: number;
  content: any;
  reason?: string;
}): Promise<any> {
  const payload = {
    asset_id: input.assetId,
    version: input.version,
    content_json: input.content,
    reason: input.reason ?? null,
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('content_asset_versions')
    .insert(payload)
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to create content version: ${error.message}`);
  }
  return data;
}

export async function listContentVersions(assetId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('content_asset_versions')
    .select('*')
    .eq('asset_id', assetId)
    .order('version', { ascending: true });
  if (error || !data) return [];
  return data;
}

export async function listAssetsWithLatestContent(input: {
  campaignId: string;
  weekNumber?: number;
  status?: string;
  /** S2-55: the authorized company; when given, a campaign that is not its own lists nothing (see listContentAssets). */
  companyId?: string;
}): Promise<any[]> {
  const assets = await listContentAssets({
    campaignId: input.campaignId,
    weekNumber: input.weekNumber,
    ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
  });
  const filtered = input.status ? assets.filter((asset) => asset.status === input.status) : assets;
  const enriched = await Promise.all(
    filtered.map(async (asset) => {
      const versions = await listContentVersions(asset.asset_id);
      const latest = versions[versions.length - 1];
      return {
        ...asset,
        latest_content: latest?.content_json ?? null,
        versions,
      };
    })
  );
  return enriched;
}

export async function updateContentAssetStatus(input: {
  assetId: string;
  status: string;
  currentVersion?: number;
}): Promise<any> {
  const payload: any = { status: input.status };
  if (input.currentVersion) {
    payload.current_version = input.currentVersion;
  }
  const { data, error } = await supabase
    .from('content_assets')
    .update(payload)
    .eq('asset_id', input.assetId)
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to update content asset: ${error.message}`);
  }
  return data;
}

export async function createContentReview(input: {
  assetId: string;
  reviewer?: string;
  status: string;
  comment?: string;
}): Promise<void> {
  const payload = {
    asset_id: input.assetId,
    reviewer: input.reviewer ?? null,
    status: input.status,
    comment: input.comment ?? null,
    created_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('content_reviews').insert(payload);
  if (error) {
    throw new Error(`Failed to create content review: ${error.message}`);
  }
}
