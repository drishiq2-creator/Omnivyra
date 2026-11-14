import { ownedDbTable } from '../db/writeOwner';
import { resolveTenantOfRow, tenantTable, TenantSeamError } from '../db/tenantTable';
import { trackEvent } from './telemetry/telemetryDispatcher';
/**
 * Auto Completion Trigger.
 * When all scheduled posts for a campaign are published and no future posts exist,
 * automatically transition execution_status to COMPLETED and emit governance events.
 * Non-blocking. Never throws.
 */

import { supabase } from '../db/supabaseClient';
import { isTerminalExecutionState } from '../governance/ExecutionStateMachine';
import { assertValidExecutionTransition } from '../governance/ExecutionStateMachine';
import { recordGovernanceEvent, recordCampaignCompletedEvent } from './GovernanceEventService';
import { updateStrategyMemoryFromSignals } from './campaignStrategyMemoryService';
import { markThemeConsumedForCampaign } from './companyThemeStateService';

/**
 * Check if campaign is eligible for auto-completion and transition if so.
 * Call after: publish success, schedule execution, post-status update to published.
 * Non-blocking. Never throws.
 */
export async function checkAndCompleteCampaignIfEligible(campaignId: string | null | undefined): Promise<void> {
  if (!campaignId) return;
  try {
    // S2 tenant seam: everything below runs under the campaign's own tenant (campaigns.company_id, read by the seam
    // from the row). A campaign with no resolvable tenant (missing row / NULL company) is not completed: silent
    // return, as before (a NULL-company campaign already stopped at the transition write; this never throws).
    // A FAILED read (retryable TENANT_PARENT_UNREADABLE, e9 2026-11-14) is not "no tenant": it is logged and the check
    // returns without completing; nothing is written, so the next trigger (publish success / release / schedule)
    // re-evaluates the campaign. Never rethrown: callers are fire-and-forget after a publish.
    const reason = 'campaign auto-completion: execution_status transition';
    let campaignCtx;
    try {
      campaignCtx = await resolveTenantOfRow('campaigns', campaignId, reason);
    } catch (err) {
      if (err instanceof TenantSeamError && err.retryable) {
        console.warn('tenant_row_unreadable', { table: 'campaigns', id: campaignId, reason, caller: 'checkAndCompleteCampaignIfEligible', error: err.message });
        return;
      }
      throw err;
    }
    if (!campaignCtx) return;
    const { data: campaign, error: campError } = await tenantTable('campaigns', campaignCtx)
      .select('id, execution_status')
      .eq('id', campaignId)
      .maybeSingle();

    if (campError || !campaign) return;
    const executionStatus = String((campaign as any).execution_status ?? 'ACTIVE').toUpperCase();
    if (isTerminalExecutionState(executionStatus as any)) return;

    const nowIso = new Date().toISOString();

    const { data: posts, error: postsError } = await ownedDbTable('scheduled_posts')
      .select('id, status, scheduled_for')
      .eq('campaign_id', campaignId);

    if (postsError || !posts || posts.length === 0) return;

    const total = posts.length;
    const published = posts.filter((p: any) => String(p.status || '').toUpperCase() === 'PUBLISHED').length;
    const hasFuture = posts.some((p: any) => {
      const sf = p.scheduled_for;
      if (!sf) return false;
      try {
        return new Date(sf).getTime() > Date.now();
      } catch {
        return false;
      }
    });

    if (total === 0 || published !== total || hasFuture) return;

    const fromState = executionStatus as any;
    try {
      assertValidExecutionTransition(fromState, 'COMPLETED');
    } catch {
      return;
    }

    const { error: updateError } = await tenantTable('campaigns', campaignCtx)
      .update({
        execution_status: 'COMPLETED',
        updated_at: nowIso,
      })
      .eq('id', campaignId);

    if (updateError) {
      console.error('CampaignCompletionService: failed to update execution_status', updateError);
      return;
    }

    const { data: cv } = await ownedDbTable('campaign_versions')
      .select('company_id')
      .eq('campaign_id', campaignId)
      .limit(1)
      .maybeSingle();

    const companyId = (cv as any)?.company_id ?? null;
    if (companyId) {
      // Adoption telemetry (append-only, fail-soft): a campaign completed.
      // Deduped per campaign id.
      trackEvent({ type: 'campaign.completed', organizationId: companyId, entityId: campaignId });
      markThemeConsumedForCampaign(campaignId).catch((err) =>
        console.warn('CampaignCompletionService: markThemeConsumedForCampaign failed', err)
      );
      updateStrategyMemoryFromSignals(companyId, campaignId).catch((err) =>
        console.warn('CampaignCompletionService: updateStrategyMemoryFromSignals failed', err)
      );
      await recordGovernanceEvent({
        companyId,
        campaignId,
        eventType: 'EXECUTION_STATE_TRANSITION',
        eventStatus: 'TRANSITIONED',
        metadata: { campaignId, from: fromState, to: 'COMPLETED' },
      });
      await recordCampaignCompletedEvent({
        companyId,
        campaignId,
        completedAt: nowIso,
        totalScheduledPosts: total,
      });
    }
  } catch (err) {
    console.error('CampaignCompletionService: checkAndCompleteCampaignIfEligible failed', err);
  }
}
