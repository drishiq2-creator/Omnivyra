/**
 * InboxDashboard - top-level layout: PlatformTabs, ThreadList, ThreadView.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import {
  NEEDS_RESPONSE_VISIBLE_LIMIT,
  selectNeedsResponseThreads,
  selectPeopleReactionThreads,
} from '@/lib/engagement/queueRules';
import { ThreadList } from '@/components/engagement/ThreadList';
import { ThreadView } from '@/components/engagement/ThreadView';
import { AIEngagementAssistant } from '@/components/engagement/AIEngagementAssistant';
import { InboxLayout } from '@/components/engagement/inbox/InboxLayout';
import { InboxHeader } from '@/components/engagement/inbox/InboxHeader';
import { useEngagementInbox } from '@/hooks/useEngagementInbox';
import { getTabCount, getUnsupportedEngagementReason, usePortalCounts } from './portalCounts';
import { useCompanyIntegrations } from '@/hooks/useCompanyIntegrations';
import { useEngagementMessages } from '@/hooks/useEngagementMessages';
import { useReply } from '@/hooks/useReply';
import {
  useBrowserAssistState,
  useBrowserAssistData,
  useBrowserAssistHandlers,
  useBrowserAssistEffects,
} from '@/hooks/useBrowserAssist';
import { useInboxOrchestrator } from '@/hooks/useInboxOrchestrator';
import type { InboxThread } from '@/hooks/useEngagementInbox';
import { normalizePlatform } from '@/utils/platformIcons';
import { resolveEngagementCapability } from '@/lib/engagementCapabilities';
import type { ThreadQueueGroup } from './threadQueueModel';
import {
  filterThreadsForQueue,
  getThreadQueueCounts,
} from './threadQueueModel';
import {
  EXTENSION_SYNC_PLATFORM_SET,
  GENERIC_BROWSER_ASSIST_PLATFORM_SET,
} from './inbox/helpers';
import {
  likeEngagementMessage,
} from '@/features/engagement/data/engagement.api';

export interface InboxDashboardProps {
  organizationId: string;
  /** Current operator's user id — drives the "Assigned to me" filter and the
   *  per-thread assignment / reply-lock collaboration UI. */
  actingUserId?: string;
  className?: string;
}

function InboxDashboardComponent({
  organizationId,
  actingUserId = '',
  className = '',
}: InboxDashboardProps) {
  const router = useRouter();
  // Phase 35-D-5a + 5b + 5c: browser-assist state at top of component,
  // sub-hook data after connected-platform memos, handlers after data,
  // effects last. This component still drives the order; the four hooks
  // in @/hooks/useBrowserAssist contain the bodies.
  const browserState = useBrowserAssistState();
  const {
    browserAssistEnabled,
    browserAssistError,
    setBrowserAssistError,
    browserAssistBusyPlatform,
    setBrowserAssistBusyPlatform,
    browserAssistStatusByPlatform,
    setBrowserAssistStatusByPlatform,
    browserAssistErrorByPlatform,
    setBrowserAssistErrorByPlatform,
    linkedInSurfaceActionBusy,
    setLinkedInSurfaceActionBusy,
    linkedInSurfaceActionStatus,
    setLinkedInSurfaceActionStatus,
    platformSyncTrust,
    setPlatformSyncTrust,
    attemptedExtensionAuthRef,
    lastPlatformSyncAtRef,
  } = browserState;

  const [selectedPlatform, setSelectedPlatform] = useState<string>('all');
  const [selectedThread, setSelectedThread] = useState<InboxThread | null>(null);
  const [mobileTab, setMobileTab] = useState<'threads' | 'conversation' | 'assistant'>('threads');
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [activeQueueFilter, setActiveQueueFilter] = useState<ThreadQueueGroup | 'all' | 'People Reacted'>('Needs Response');
  const [assigneeFilter, setAssigneeFilter] = useState<'all' | 'mine' | 'unassigned'>('all');
  const [authorFilter, setAuthorFilter] = useState<{ authorName: string; platform: string } | null>(
    null
  );
  // Switching primary tab is the user's signal that they want fresh data
  // for that view — kick a re-fetch. Skips first mount (the inbox load
  // already runs there) and avoids a double-fetch on initial render.
  const isFirstFilterRender = useRef(true);

  const filters = useMemo(
    () => ({
      platform: selectedPlatform && selectedPlatform !== 'all' ? selectedPlatform : undefined,
      priority: undefined as 'high' | 'medium' | 'low' | undefined,
    }),
    [selectedPlatform]
  );

  // E4: ONE server-side count definition (engagement-portal-counts.v1) feeds
  // every badge and header total. /api/engagement/work-queue serves the same
  // numbers, so the old second fetch is gone; `refreshWorkQueue` stays a
  // no-op for the hooks that still accept it (counts refresh covers it).
  const {
    state: portalCounts,
    loading: countsLoading,
    refresh: refreshCounts,
  } = usePortalCounts(organizationId);
  const refreshWorkQueue = useCallback(async () => {}, []);
  const countsUnavailable = portalCounts.status === 'unknown';
  // While counts are unknown (failed read) or loading, there is no handled map:
  // threads the server would hide as resolved / company-answered may reappear
  // in the lists until counts load. That is the deliberate safe direction —
  // an extra item shown, never real work hidden — and the badges say "—".
  const handledThreads = portalCounts.status === 'ready' ? portalCounts.handledThreads : null;
  const { platforms: integrations } = useCompanyIntegrations(organizationId);
  const connectedPlatformSlugs = useMemo(
    () => Array.from(
      new Set(
        integrations
          .map((integration) => normalizePlatform(integration.platform))
          .filter(Boolean)
      )
    ),
    [integrations]
  );
  const hasLinkedInConnection = useMemo(
    () => integrations.some((integration) => normalizePlatform(integration.platform) === 'linkedin'),
    [integrations]
  );
  // Phase 35-D-5c: 4 sub-hooks (platform health, extension bridge,
  // workspace preferences, LinkedIn workspace) extracted into
  // useBrowserAssistData. Returns a flat object whose keys match the
  // names this component already uses, so the destructure is byte-equivalent.
  const {
    platformHealth,
    platformHealthLoading,
    refreshPlatformHealth,
    extensionStatus,
    extensionAuth,
    extensionLoading,
    extensionError,
    refreshExtension,
    mergedPlatforms,
    updatingBrowserPlatform,
    extensionAuthenticating,
    setBrowserPlatformEnabled,
    authenticateExtensionViaClaimCode,
    pollExtensionCommandsNow,
    triggerPlatformSync,
    executePlatformAction,
    workspacePreferenceMap,
    workspacePreferencesLoading,
    refreshWorkspacePreferences,
    updatingWorkspacePlatform,
    setWorkspacePlatformEnabled,
    linkedinOverview,
    linkedinOverviewLoading,
    linkedinSyncing,
    linkedinOverviewError,
    linkedinLastSyncResult,
    refreshLinkedInOverview,
    syncLinkedInNow,
  } = useBrowserAssistData({ organizationId, integrations, hasLinkedInConnection });
  const { items, loading, error, refresh, patchThread } = useEngagementInbox(organizationId, filters);
  useEffect(() => {
    if (isFirstFilterRender.current) {
      isFirstFilterRender.current = false;
      return;
    }
    refresh();
  }, [activeQueueFilter, refresh]);
  const {
    messages,
    loading: messagesLoading,
    refresh: refreshMessages,
  } = useEngagementMessages(
    organizationId,
    selectedThread?.thread_id ?? null,
    selectedThread?.sibling_thread_ids ?? []
  );

  const threadIdFromUrl = typeof router.query.thread === 'string' ? router.query.thread : null;

  const filteredItems = useMemo((): InboxThread[] => {
    let base = items;
    if (authorFilter) {
      base = base.filter(
        (t) =>
          (t.author_name === authorFilter.authorName ||
            t.author_username === authorFilter.authorName) &&
          t.platform === authorFilter.platform
      );
    }
    // Collaboration assignee filter (Assigned to me / Unassigned / All).
    if (assigneeFilter === 'mine') {
      base = actingUserId ? base.filter((t) => t.assigned_to === actingUserId) : base;
    } else if (assigneeFilter === 'unassigned') {
      base = base.filter((t) => !t.assigned_to);
    }
    return base;
  }, [items, authorFilter, assigneeFilter, actingUserId]);
  // Split filteredItems into the two universes the UI cares about:
  //   - dmThreads:      DMs and direct conversations (Needs Response domain)
  //   - postThreads:    activity on the user's posts (People Reaction domain)
  // Doing the split once here keeps the count badges consistent with what's
  // actually shown in each tab.
  // "Needs response" rule: only DMs where the *other party* sent the last
  // message AND the user hasn't already queued an outbound reply through
  // the engagement pipeline. If the user already replied (outgoing or
  // author_self=true on the latest, OR an in-flight community_ai_actions
  // row exists), the thread drops out of the queue until the counterparty
  // sends something new — otherwise the operator sees their own replies
  // sitting in the inbox waiting for action that's already been taken.
  // E4: a thread the server reports handled (persisted "Mark resolved", or a
  // company turn found via the connected-account map) at/after its latest
  // message leaves the list, exactly as it leaves the server count.
  const dmThreads = useMemo(
    () => selectNeedsResponseThreads(filteredItems, undefined, handledThreads),
    [filteredItems, handledThreads]
  );
  // People Reaction visibility rules (operator-defined):
  //   1. Only comment threads where someone else wrote the latest comment.
  //      The window is rolling — every fetch advances "now," so when the
  //      user signs back in after a gap they see whatever's actionable in
  //      the current 60-day slice rather than an unbounded backlog.
  //   2. Hide once the latest visible comment is self-authored or a reply
  //      action for that thread has already been completed.
  //
  // Note: Date.now() lives INSIDE the useMemo, not in deps, otherwise the
  // ms-level drift on every render would re-create the array reference,
  // invalidate visibleQueueItems, fire the recommendation useEffect, and
  // trigger an infinite re-render loop ("Maximum update depth exceeded").
  const postThreads = useMemo(
    () => selectPeopleReactionThreads(filteredItems, undefined, handledThreads),
    [filteredItems, handledThreads]
  );

  const needsResponseQueueItems = useMemo(
    () => filterThreadsForQueue(dmThreads, 'Needs Response').slice(0, NEEDS_RESPONSE_VISIBLE_LIMIT),
    [dmThreads]
  );
  const visibleQueueItems = useMemo(() => {
    if (activeQueueFilter === 'People Reacted') return postThreads;
    // Needs Response / High Priority / Waiting / Done are DM-domain views;
    // run queue grouping only over DM threads so post threads never leak
    // into the priority queues.
    return activeQueueFilter === 'Needs Response'
      ? needsResponseQueueItems
      : filterThreadsForQueue(dmThreads, activeQueueFilter).slice(0, NEEDS_RESPONSE_VISIBLE_LIMIT);
  }, [activeQueueFilter, dmThreads, needsResponseQueueItems, postThreads]);

  // E4: header badges are SERVER counts for the selected tab ('all' = totals),
  // never the length of the (top-N, tab-scoped) visible list. null = unknown.
  const selectedTabCount = getTabCount(portalCounts, selectedPlatform || 'all');
  const needsResponseCount: number | null = selectedTabCount?.needs_response ?? null;
  const peopleReactedCount: number | null = selectedTabCount?.people_reaction ?? null;
  const unsupportedReasons = useMemo(() => {
    const out: Record<string, string> = {};
    for (const integration of integrations) {
      const slug = normalizePlatform(integration.platform);
      const reason = slug ? getUnsupportedEngagementReason(slug) : null;
      if (slug && reason) out[slug === 'x' ? 'twitter' : slug] = reason;
    }
    return out;
  }, [integrations]);
  const selectedUnsupportedReason =
    selectedPlatform && selectedPlatform !== 'all' ? unsupportedReasons[selectedPlatform] ?? null : null;

  const getBrowserActionPlatform = useCallback((platform: string) => {
    const normalized = normalizePlatform(platform);
    return normalized === 'twitter' ? 'x' : normalized;
  }, []);

  const syncableBrowserPlatforms = useMemo(
    () => Array.from(
      new Set(
        connectedPlatformSlugs
          .map((platform) => getBrowserActionPlatform(platform))
          .filter((platform) => EXTENSION_SYNC_PLATFORM_SET.has(platform))
      )
    ),
    [connectedPlatformSlugs, getBrowserActionPlatform]
  );

  // The visible list's own length — used only for list-state decisions
  // (empty states, recommendation), never shown as a count. E4 removed the
  // browser-side per-platform badge recomputation that used to live here
  // (top-10-capped, tab-scoped, per-post); badges are server counts.
  const queueCounts = useMemo(() => getThreadQueueCounts(needsResponseQueueItems), [needsResponseQueueItems]);

  const actionableThreads = queueCounts.needsResponse;
  const connectedPlatformsCount = connectedPlatformSlugs.length;
  const connectedPlatformSet = useMemo(
    () => new Set(connectedPlatformSlugs),
    [connectedPlatformSlugs]
  );
  const connectedPlatformHealth = useMemo(
    () => platformHealth.filter((platform) => connectedPlatformSet.has(normalizePlatform(platform.platform))),
    [connectedPlatformSet, platformHealth]
  );
  const extensionPanelPlatforms = useMemo(() => {
    return connectedPlatformSlugs.map((platform) => {
      const extensionPlatform = mergedPlatforms.find((entry) => entry.platform === platform);

      return {
        platform,
        connected: true,
        browserEnabled: extensionPlatform?.browserEnabled ?? true,
        hasOpenTab: extensionPlatform?.hasOpenTab ?? false,
        openTabCount: extensionPlatform?.openTabCount ?? 0,
        hasMessagingTab: extensionPlatform?.hasMessagingTab ?? false,
        hasFeedTab: extensionPlatform?.hasFeedTab ?? false,
        hasSalesNavigatorTab: extensionPlatform?.hasSalesNavigatorTab ?? false,
        hasRecruiterTab: extensionPlatform?.hasRecruiterTab ?? false,
        workspaceEnabled: workspacePreferenceMap[platform] ?? true,
      };
    });
  }, [connectedPlatformSlugs, mergedPlatforms, workspacePreferenceMap]);
  const updatingExtensionPlatform = updatingWorkspacePlatform || updatingBrowserPlatform;
  const linkedInBrowserState = extensionPanelPlatforms.find((platform) => platform.platform === 'linkedin');
  const genericBrowserPlatforms = useMemo(
    () =>
      extensionPanelPlatforms.filter((platform) =>
        GENERIC_BROWSER_ASSIST_PLATFORM_SET.has(platform.platform)
      ),
    [extensionPanelPlatforms]
  );
  const getBrowserPlatformState = useCallback(
    (platform: string) => {
      const browserPlatform = getBrowserActionPlatform(platform);
      return extensionPanelPlatforms.find((entry) => entry.platform === browserPlatform) ?? null;
    },
    [extensionPanelPlatforms, getBrowserActionPlatform]
  );

  const requiresVerifiedBrowserReply = useCallback((platform: string) => {
    return ['linkedin', 'facebook', 'instagram', 'x'].includes(getBrowserActionPlatform(platform));
  }, [getBrowserActionPlatform]);

  const getVerifiedReplyRequirementMessage = useCallback((platform: string) => {
    const normalized = getBrowserActionPlatform(platform);
    if (normalized === 'linkedin') {
      return 'LinkedIn DM and comment replies require a verified browser-assisted send. Open LinkedIn Messaging for DMs, or the relevant LinkedIn conversation surface, before sending.';
    }
    if (normalized === 'facebook') {
      return 'Facebook replies and message actions require a verified browser-assisted send. Open Messenger or the relevant Facebook conversation surface before sending.';
    }
    if (normalized === 'instagram') {
      return 'Instagram replies and direct-message actions require a verified browser-assisted send. Open Instagram Direct or the relevant thread before sending.';
    }
    if (normalized === 'x') {
      return 'X replies and direct-message actions require a verified browser-assisted send. Open X Messages or the relevant reply surface before sending.';
    }
    return `${normalized} engagement actions require a verified browser-assisted send before Omnivyra can trust them.`;
  }, [getBrowserActionPlatform]);
  const extensionUserLabel =
    extensionAuth?.user?.email ||
    extensionAuth?.user?.name ||
    extensionAuth?.userId ||
    null;

  const handleLike = useCallback(
    async (messageId: string, platform: string) => {
      if (!organizationId) return;

      // Capability gate (synchronous; no fetch needed). Reporting via
      // setBrowserAssistError so the user sees an inline message instead
      // of throwing — Next.js 16's dev overlay otherwise turns any throw
      // here into a fullscreen "Runtime Error" page even if it's caught.
      const capability = resolveEngagementCapability(platform, 'like');
      if (capability.status !== 'api_verified') {
        setBrowserAssistError(capability.reason ?? `Like is not supported on ${platform}.`);
        return;
      }

      try {
        const res = await likeEngagementMessage({
          organizationId,
          messageId,
          platform,
        });
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          status?: string;
          confirmed?: boolean;
          platform_id?: string | null;
          success?: boolean;
        };

        if (!res.ok || json.status !== 'executed' || json.success !== true) {
          // Surface the server's reason inline. No throw — Next.js dev
          // overlay would intercept it as a runtime error otherwise.
          const reason = json.error
            || (json.code === 'PLACEHOLDER_TARGET'
              ? 'Demo seed row — real LinkedIn URN required to like.'
              : 'Platform did not confirm the like.');
          console.warn('[engagement] like rejected:', { code: json.code, reason });
          setBrowserAssistError(reason);
          return;
        }

        // Observability distinction: confirmed like vs sent-but-unconfirmed.
        if (!json.confirmed) {
          console.info('[engagement] like accepted by platform but no id returned', {
            messageId,
            platform,
          });
        }
        refreshMessages();
      } catch (err) {
        // Network-level error or JSON parse failure — same inline path.
        console.error('[engagement] like network error:', err);
        setBrowserAssistError(
          err instanceof Error ? err.message : 'Like request failed'
        );
      }
    },
    [organizationId, refreshMessages]
  );

  // ── Phase 35-D-6: useInboxOrchestrator owns the engagement business logic ──
  // runPlatformSyncAndRefresh + handleRefresh, recommendation lifecycle,
  // thread selection / persistence / ignore / mark-resolved, empty-state
  // derivation, keyboard shortcuts. Bodies + dep arrays preserved verbatim.
  const orchestrator = useInboxOrchestrator({
    organizationId,
    router,
    items,
    error,
    loading,
    refresh,
    patchThread,
    messages,
    refreshMessages,
    refreshCounts,
    refreshWorkQueue,
    pollExtensionCommandsNow,
    triggerPlatformSync,
    refreshLinkedInOverview,
    setBrowserAssistError,
    platformSyncTrust,
    setPlatformSyncTrust,
    attemptedExtensionAuthRef,
    lastPlatformSyncAtRef,
    selectedPlatform,
    setSelectedPlatform,
    selectedThread,
    setSelectedThread,
    setMobileTab,
    setAiDrawerOpen,
    authorFilter,
    threadIdFromUrl,
    filteredItems,
    visibleQueueItems,
    actionableThreads,
    syncableBrowserPlatforms,
    getBrowserActionPlatform,
    handleLike,
  });
  const { runPlatformSyncAndRefresh, handleRefresh } = orchestrator;
  const {
    recommendedThread,
    recommendationIsFading,
  } = orchestrator.recommendationState;
  const {
    handleSelectThread,
    handleSelectThreadById,
    handleSelectPlatform,
    handleIgnore,
    handleMarkResolved,
    hideThreadAfterResponse,
    handleReplySent,
  } = orchestrator.threadState;
  const {
    hasBlockingError,
    showSyncUnverifiedState,
    showNoActivityState,
    showAllCaughtUpState,
    conversationEmptyState,
  } = orchestrator.emptyState;

  const queueEmptyState = useMemo(() => {
    if (hasBlockingError) {
      return (
        <div className="mx-auto w-full max-w-sm rounded-2xl border border-red-200 bg-red-50 p-5 text-center">
          <h3 className="text-base font-semibold text-red-900">We&apos;re having trouble loading your conversations.</h3>
          <p className="mt-2 text-sm leading-6 text-red-800">{error}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={handleRefresh}
              className="rounded-full bg-red-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-800"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => router.push('/social-platforms')}
              className="rounded-full border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-900 transition hover:bg-red-100"
            >
              Reconnect platform
            </button>
          </div>
        </div>
      );
    }

    if (showNoActivityState) {
      return (
        <div className="mx-auto w-full max-w-sm rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center">
          <h3 className="text-base font-semibold text-slate-900">No conversations yet</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Once people reply to your posts or messages, they&apos;ll appear here.
          </p>
        </div>
      );
    }

    if (showSyncUnverifiedState) {
      return (
        <div className="mx-auto w-full max-w-sm rounded-2xl border border-amber-200 bg-amber-50 p-5 text-center">
          <h3 className="text-base font-semibold text-amber-950">
            Checking latest messages
          </h3>
          <p className="mt-2 text-sm leading-6 text-amber-900">
            {platformSyncTrust.message
              || 'Omnivyra is refreshing the browser inbox before showing the queue.'}
          </p>
          <button
            type="button"
            onClick={handleRefresh}
            className="mt-4 rounded-full bg-amber-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-800"
          >
            Check latest messages
          </button>
        </div>
      );
    }

    if (showAllCaughtUpState) {
      return (
        <div className="mx-auto w-full max-w-sm rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
          <h3 className="text-base font-semibold text-emerald-900">All caught up 🎉</h3>
          <p className="mt-2 text-sm leading-6 text-emerald-800">
            You&apos;re up to date. We&apos;ll surface new conversations here.
          </p>
        </div>
      );
    }

    return undefined;
  }, [
    error,
    handleRefresh,
    hasBlockingError,
    platformSyncTrust.message,
    platformSyncTrust.status,
    router,
    showAllCaughtUpState,
    showNoActivityState,
    showSyncUnverifiedState,
  ]);

  // ── Phase 35-D-5b: 7 useCallback handlers extracted to hooks/useBrowserAssist.ts ──
  const {
    handleToggleExtensionPlatform,
    bootstrapExtensionAuth,
    handleRefreshExtensionPanel,
    handleSyncLinkedIn,
    handleRunLinkedInBrowserAssist,
    handleRunPlatformBrowserAssist,
    handleCaptureLinkedInSurface,
  } = useBrowserAssistHandlers(browserState, {
    organizationId,
    extensionStatus,
    extensionAuth,
    extensionError,
    authenticateExtensionViaClaimCode,
    setBrowserPlatformEnabled,
    triggerPlatformSync,
    executePlatformAction,
    refreshExtension,
    setWorkspacePlatformEnabled,
    refreshWorkspacePreferences,
    syncLinkedInNow,
    refreshLinkedInOverview,
    getBrowserActionPlatform,
    getBrowserPlatformState,
    refresh,
    refreshCounts,
    refreshWorkQueue,
    refreshMessages,
  });

  // ── Reply orchestration extracted to hooks/useReply.ts (Phase 35-B) ──
  // The hook owns the dispatch flow (api/browser-mode branching, queued
  // delivery polling, cancel-on-failure) and calls back into refresh
  // hooks. State (replyText, aiDraftId, sending, error) stays in the
  // consumers (ReplyComposer / ConversationView).
  const { executeReply: handleExecuteReply, retryQueuedDelivery: handleRetryQueuedDelivery } = useReply({
    organizationId,
    getBrowserPlatformState,
    hideThreadAfterResponse,
    bootstrapExtensionAuth: async () => {
      await bootstrapExtensionAuth();
    },
    pollExtensionCommandsNow,
    refresh,
    refreshMessages,
    refreshCounts,
    refreshWorkQueue,
  });

  // Phase 35-D-5c: 4 useEffects (visibility lock, auto-bootstrap, initial
  // platform sync, background sync interval) moved into useBrowserAssistEffects.
  // Bodies + dep arrays + cleanup functions all preserved verbatim.
  useBrowserAssistEffects(browserState, {
    organizationId,
    extensionStatus,
    extensionAuth,
    extensionError,
    bootstrapExtensionAuth,
    syncableBrowserPlatforms,
    runPlatformSyncAndRefresh,
    browserAssistEnabled,
  });

  if (!organizationId) {
    return (
      <div className={`flex h-full flex-col items-center justify-center p-8 text-slate-500 ${className}`}>
        Select a company to view the engagement inbox.
      </div>
    );
  }

  return (
    <div className={`flex h-full flex-col ${className}`}>
      <InboxHeader
        queueStats={{
          activeQueueFilter,
          actionableThreads: needsResponseCount,
          connectedPlatformsCount,
          visibleThreadCount: dmThreads.length + postThreads.length,
          refreshDisabled: loading || countsLoading,
        }}
        browserAssist={{
          enabled: browserAssistEnabled,
          hasLinkedInConnection,
          extensionPanel: {
            loading: extensionLoading || workspacePreferencesLoading || extensionAuthenticating,
            error: extensionError,
            authenticated: Boolean(extensionAuth?.isAuthenticated),
            orgId: extensionAuth?.orgId ?? null,
            userLabel: extensionUserLabel,
            runtimeId: extensionStatus?.runtimeId ?? null,
            version: extensionStatus?.version ?? null,
            platforms: extensionPanelPlatforms,
            updatingPlatform: updatingExtensionPlatform,
            authenticating: extensionAuthenticating,
            onRefresh: handleRefreshExtensionPanel,
            onTogglePlatform: handleToggleExtensionPlatform,
            onConnect: async () => {
              if (!organizationId) return;
              await authenticateExtensionViaClaimCode(organizationId);
            },
          },
          linkedinPanel: {
            loading: linkedinOverviewLoading,
            syncing: linkedinSyncing,
            surfaceActionBusy: linkedInSurfaceActionBusy,
            error: browserAssistError || linkedinOverviewError,
            surfaceActionStatus: linkedInSurfaceActionStatus,
            overview: linkedinOverview,
            lastSyncResult: linkedinLastSyncResult,
            extensionAuthenticated: Boolean(extensionAuth?.isAuthenticated),
            browserAssistAvailable: Boolean(linkedInBrowserState?.browserEnabled),
            browserTabOpen: Boolean(linkedInBrowserState?.hasOpenTab),
            browserMessagingTabOpen: Boolean(linkedInBrowserState?.hasMessagingTab),
            browserFeedTabOpen: Boolean(linkedInBrowserState?.hasFeedTab),
            browserSalesNavigatorTabOpen: Boolean(linkedInBrowserState?.hasSalesNavigatorTab),
            browserRecruiterTabOpen: Boolean(linkedInBrowserState?.hasRecruiterTab),
            onRefresh: refreshLinkedInOverview,
            onSyncNow: handleSyncLinkedIn,
            onRunBrowserAssist: linkedInBrowserState?.browserEnabled ? handleRunLinkedInBrowserAssist : null,
            onCaptureSalesNavigator: linkedInBrowserState?.browserEnabled
              ? () => handleCaptureLinkedInSurface('sales_navigator')
              : null,
            onCaptureRecruiter: linkedInBrowserState?.browserEnabled
              ? () => handleCaptureLinkedInSurface('recruiter')
              : null,
          },
          browserOpsPanel: {
            loading: extensionLoading || extensionAuthenticating,
            authenticated: Boolean(extensionAuth?.isAuthenticated),
            platforms: genericBrowserPlatforms,
            busyPlatform: browserAssistBusyPlatform,
            statusByPlatform: browserAssistStatusByPlatform,
            errorByPlatform: browserAssistErrorByPlatform,
            onRunBrowserAssist: handleRunPlatformBrowserAssist,
          },
        }}
        platformTabs={{
          getCount: (slug: string) => getTabCount(portalCounts, slug),
          countsUnavailable,
          onRetryCounts: () => { void refreshCounts(); },
          unsupportedReasons,
          selectedPlatform,
          onSelectPlatform: handleSelectPlatform,
          platforms: connectedPlatformSlugs,
          loading: countsLoading,
        }}
        platformHealth={{
          platforms: connectedPlatformHealth,
          selectedPlatform,
          organizationId,
          onSelectPlatform: handleSelectPlatform,
          onHealthRefresh: refreshPlatformHealth,
          loading: platformHealthLoading,
        }}
        onRefreshWorkspace={handleRefresh}
        onSetQueueFilter={setActiveQueueFilter as (filter: string) => void}
      />

      <div className="shrink-0 border-b border-slate-200 bg-white md:hidden">
        <div className="flex">
          <button
            type="button"
            onClick={() => setMobileTab('threads')}
            className={`flex-1 px-4 py-2 text-sm font-medium ${
              mobileTab === 'threads' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-slate-600'
            }`}
          >
            Threads
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('conversation')}
            className={`flex-1 px-4 py-2 text-sm font-medium ${
              mobileTab === 'conversation'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-slate-600'
            }`}
          >
            Conversation
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('assistant')}
            className={`flex-1 px-4 py-2 text-sm font-medium ${
              mobileTab === 'assistant'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-slate-600'
            }`}
          >
            AI
          </button>
        </div>
      </div>

      <InboxLayout
        mobileTab={mobileTab}
        aiDrawerOpen={aiDrawerOpen}
        onAiDrawerToggle={() => setAiDrawerOpen(!aiDrawerOpen)}
        onAiDrawerClose={() => setAiDrawerOpen(false)}
        threadList={(
          <>
            {/* Sticky primary view-mode tabs at the top of the left column.
                These are duplicated from the page header so they stay visible
                when the user scrolls the thread list. Two tabs cover the two
                fundamental triage modes (DMs vs reactions on your posts). */}
            <div className="sticky top-0 z-10 flex shrink-0 border-b border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => setActiveQueueFilter('Needs Response')}
                aria-pressed={activeQueueFilter !== 'People Reacted'}
                className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold transition ${activeQueueFilter !== 'People Reacted' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-transparent text-slate-600 hover:bg-slate-50'}`}
              >
                <span>📥 Needs Response</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${activeQueueFilter !== 'People Reacted' ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-700'}`}>
                  {needsResponseCount ?? '—'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActiveQueueFilter('People Reacted')}
                aria-pressed={activeQueueFilter === 'People Reacted'}
                className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold transition ${activeQueueFilter === 'People Reacted' ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-transparent text-slate-600 hover:bg-slate-50'}`}
              >
                <span>💬 People Reaction</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${activeQueueFilter === 'People Reacted' ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'}`}>
                  {peopleReactedCount ?? '—'}
                </span>
              </button>
            </div>
            {/* Collaboration assignee filter (Batch 2). */}
            <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3 py-2 text-xs">
              <span className="mr-1 font-medium text-slate-400">Assignee:</span>
              {([
                { key: 'all', label: 'All' },
                { key: 'mine', label: 'Assigned to me' },
                { key: 'unassigned', label: 'Unassigned' },
              ] as const).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setAssigneeFilter(opt.key)}
                  aria-pressed={assigneeFilter === opt.key}
                  className={`rounded-full px-2.5 py-1 font-medium transition ${assigneeFilter === opt.key ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {selectedUnsupportedReason ? (
              <div
                role="status"
                data-testid="platform-unsupported-state"
                className="mx-3 mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
              >
                <p className="font-semibold text-slate-900">Not supported on this platform</p>
                <p className="mt-1 leading-6">Not supported: {selectedUnsupportedReason}</p>
              </div>
            ) : null}
            <ThreadList
              items={visibleQueueItems}
              loading={loading}
              selectedThreadId={selectedThread?.thread_id}
              recommendedThreadId={recommendedThread?.thread_id ?? null}
              recommendationIsFading={recommendationIsFading}
              activeFilter={activeQueueFilter}
              onSelectThread={(thread) => {
                handleSelectThread(thread);
                setMobileTab('conversation');
              }}
              emptyMessage={
                authorFilter
                  ? `No threads from ${authorFilter.authorName} on ${authorFilter.platform}.`
                  : activeQueueFilter === 'all'
                    ? 'No threads in inbox.'
                    : `No threads in ${activeQueueFilter.toLowerCase()} right now.`
              }
              emptyState={selectedUnsupportedReason ? <span /> : queueEmptyState}
              authorFilter={authorFilter}
              onClearAuthorFilter={authorFilter ? () => setAuthorFilter(null) : undefined}
            />
          </>
        )}
        conversation={(
          <ThreadView
            thread={selectedThread}
            messages={messages}
            loading={messagesLoading && messages.length === 0}
            organizationId={organizationId}
            actingUserId={actingUserId}
            emptyStateTitle={conversationEmptyState.title}
            emptyStateDescription={conversationEmptyState.description}
            onRefresh={refreshMessages}
            onReplySent={handleReplySent}
            onExecuteReply={handleExecuteReply}
            onLike={handleLike}
            onIgnore={handleIgnore}
            onMarkResolved={handleMarkResolved}
            onRetryQueuedDelivery={handleRetryQueuedDelivery}
          />
        )}
        rightPanelDesktop={(
          <AIEngagementAssistant
            thread={selectedThread}
            messages={messages}
            organizationId={organizationId}
            recommendedThread={recommendedThread}
            onSelectThread={(threadId) => {
              handleSelectThreadById(threadId);
              setMobileTab('threads');
            }}
            onFilterByAuthor={(authorName, platform) => {
              setAuthorFilter({ authorName, platform });
              setMobileTab('threads');
            }}
          />
        )}
        rightPanelDrawer={(
          <AIEngagementAssistant
            thread={selectedThread}
            messages={messages}
            organizationId={organizationId}
            recommendedThread={recommendedThread}
            onSelectThread={(threadId) => {
              handleSelectThreadById(threadId);
              setMobileTab('threads');
            }}
            onFilterByAuthor={(authorName, platform) => {
              setAuthorFilter({ authorName, platform });
              setMobileTab('threads');
              setAiDrawerOpen(false);
            }}
            className="h-full border-0"
          />
        )}
        rightPanelMobile={(
          <AIEngagementAssistant
            thread={selectedThread}
            messages={messages}
            organizationId={organizationId}
            recommendedThread={recommendedThread}
            onSelectThread={(threadId) => {
              handleSelectThreadById(threadId);
              setMobileTab('threads');
            }}
            onFilterByAuthor={(authorName, platform) => {
              setAuthorFilter({ authorName, platform });
              setMobileTab('threads');
            }}
          />
        )}
      />
    </div>
  );
}

export const InboxDashboard = React.memo(InboxDashboardComponent);
