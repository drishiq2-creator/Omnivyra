import { fetchWithAuth } from '../community-ai/fetchWithAuth';
import type { ChatMessage, StructuredPlan } from './types';
import { resolveReturnedCampaignId } from '../../lib/campaign/returnedCampaignId';

type Params = {
  campaignId?: string;
  isOpen: boolean;
  context?: string;
  selectedPlan: string;
  generateDefaultPlan: () => string;
  selectedProvider: string;
  resolvedCompanyId: string;
  structuredPlan: StructuredPlan | null;
  resolveWorkingDurationWeeks: () => number;
  getProviderName: (provider: any) => string;
  setIsLoading: (value: boolean) => void;
  setRetrievePlanData: (value: any) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setShowDateSelection: (value: boolean) => void;
  setSelectedPlan: (value: string) => void;
};

export function useCampaignPlanCreation({
  campaignId,
  isOpen,
  context,
  selectedPlan,
  generateDefaultPlan,
  selectedProvider,
  resolvedCompanyId,
  structuredPlan,
  resolveWorkingDurationWeeks,
  getProviderName,
  setIsLoading,
  setRetrievePlanData,
  setMessages,
  setShowDateSelection,
  setSelectedPlan,
}: Params) {
  return async function create12WeekPlan(startDate: string, durationWeeks?: number) {
    // The id every step AFTER the create response uses (see resolveReturnedCampaignId below).
    let effectiveCampaignId = campaignId;
    try {
      setIsLoading(true);
      const aiContent = selectedPlan || generateDefaultPlan();

      if (!campaignId) {
        console.error('Campaign ID is missing. Props received:', { campaignId, isOpen, context });
        throw new Error('Campaign ID is missing. Please refresh the page and try again.');
      }
      if (!startDate) throw new Error('Start date is missing');
      if (!aiContent) throw new Error('AI content is missing');

      const resolvedDuration =
        typeof durationWeeks === 'number' && durationWeeks >= 1 && durationWeeks <= 52
          ? durationWeeks
          : resolveWorkingDurationWeeks();
      const body: Record<string, unknown> = {
        campaignId,
        startDate,
        aiContent,
        provider: selectedProvider,
        companyId: resolvedCompanyId || undefined,
        ...(typeof resolvedDuration === 'number' && resolvedDuration >= 1 && resolvedDuration <= 52
          ? { durationWeeks: resolvedDuration }
          : {}),
      };
      if (structuredPlan?.weeks?.length) {
        body.structuredPlan = { weeks: structuredPlan.weeks };
      }

      const response = await fetchWithAuth('/api/campaigns/create-12week-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const detail = errorData.details || errorData.message || errorData.error || 'Unknown error';
        const hint = errorData.hint ? ` (${errorData.hint})` : '';
        throw new Error(`Failed to create plan: ${detail}${hint}`);
      }

      const result = await response.json();
      // Phase 1 of the deleted-campaign takeover fix (owner ruling 2026-11-18): adopt the server's
      // campaign_id; the server will mint it in phase 2. Changed by orchestration (89) under the
      // owner's ruling while no UI session was running.
      const adoptedCampaignId = resolveReturnedCampaignId(campaignId, result);
      effectiveCampaignId = adoptedCampaignId;
      const refetchRes = await fetch(`/api/campaigns/retrieve-plan?campaignId=${encodeURIComponent(adoptedCampaignId)}`);
      if (refetchRes.ok) {
        const refetchData = await refetchRes.json();
        setRetrievePlanData(refetchData);
      }

      const weeksMsg = typeof resolvedDuration === 'number' ? resolvedDuration : resolveWorkingDurationWeeks();
      const successMessage: ChatMessage = {
        id: Date.now(),
        type: 'ai',
        message: `Campaign plan created successfully for ${weeksMsg} weeks, starting ${new Date(startDate).toLocaleDateString()}. Use **View submitted plan** above to open your plan.`,
        timestamp: new Date().toLocaleTimeString(),
        provider: getProviderName(selectedProvider),
        campaignId: adoptedCampaignId,
      };
      setMessages((prev) => [...prev, successMessage]);
      setShowDateSelection(false);
      setSelectedPlan('');

      if (typeof window !== 'undefined') {
        const currentUrl = new URL(window.location.href);
        const nextParams = new URLSearchParams();
        const companyIdParam = currentUrl.searchParams.get('companyId') || resolvedCompanyId;
        if (companyIdParam) nextParams.set('companyId', companyIdParam);
        if (currentUrl.searchParams.get('fromRecommendation') === '1') {
          nextParams.set('fromRecommendation', '1');
          const recommendationIdParam = currentUrl.searchParams.get('recommendationId');
          if (recommendationIdParam) nextParams.set('recommendationId', recommendationIdParam);
        }
        nextParams.set('focus', 'weekly-blueprint');
        window.location.href = `/campaign-details/${encodeURIComponent(adoptedCampaignId)}?${nextParams.toString()}`;
      }
    } catch (error) {
      console.error('Error creating campaign plan:', error);
      const errorMessage: ChatMessage = {
        id: Date.now(),
        type: 'ai',
        message: 'Error: Failed to create campaign plan. Please try again.',
        timestamp: new Date().toLocaleTimeString(),
        provider: getProviderName(selectedProvider),
        campaignId: effectiveCampaignId,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };
}
