/**
 * Portal counts — client side of the E4 single count definition.
 *
 * The numbers are computed ONLY on the server (GET /api/engagement/platform-counts
 * → backend/services/engagementPortalCountsService.ts). This module reads them,
 * and turns a failed read into an explicit "unknown" state: the UI then shows
 * "—" plus an alert, never 0 and never "not connected".
 */

import { useCallback } from 'react';
import useSWR from 'swr';
import {
  ENGAGEMENT_CAPABILITY_MATRIX,
  isEngagementPlatformVerified,
  normalizePlatformSlug,
  resolveEngagementCapability,
  type EngagementPlatform,
} from '@/lib/engagementCapabilities';
import type { HandledThreadMap } from '@/lib/engagement/queueRules';

export type PortalTabCount = {
  needs_response: number;
  people_reaction: number;
  actionable_items: number;
  high_priority: number;
};

export type PortalCountsResponse = {
  definition?: string;
  counts?: Record<string, Partial<PortalTabCount>>;
  totals?: Partial<PortalTabCount>;
  handled_threads?: HandledThreadMap;
};

export type PortalCountsState =
  | { status: 'loading' }
  | { status: 'unknown'; error: string }
  | {
      status: 'ready';
      platforms: Record<string, PortalTabCount>;
      totals: PortalTabCount;
      handledThreads: HandledThreadMap;
    };

const COUNTS_REFRESH_INTERVAL_MS = 60 * 1000;

function toCount(raw: Partial<PortalTabCount> | undefined): PortalTabCount | null {
  if (!raw || typeof raw !== 'object') return null;
  const keys: Array<keyof PortalTabCount> = ['needs_response', 'people_reaction', 'actionable_items', 'high_priority'];
  const out = {} as PortalTabCount;
  for (const key of keys) {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[key] = v;
  }
  return out;
}

/**
 * Pure: response (or error) → state. A payload without the definition's totals
 * is treated as unreadable, not as zero.
 */
export function readPortalCounts(data: unknown, error: unknown): PortalCountsState {
  if (error) {
    const message = error instanceof Error && error.message ? error.message : 'Counts could not be loaded';
    return { status: 'unknown', error: message };
  }
  if (data === undefined) return { status: 'loading' };
  const body = data as PortalCountsResponse | null;
  const totals = toCount(body?.totals);
  if (!body || !totals || !body.counts || typeof body.counts !== 'object') {
    return { status: 'unknown', error: 'Counts response was incomplete' };
  }
  const platforms: Record<string, PortalTabCount> = {};
  for (const [slug, raw] of Object.entries(body.counts)) {
    const c = toCount(raw);
    if (!c) return { status: 'unknown', error: `Counts for ${slug} were incomplete` };
    platforms[slug] = c;
  }
  const handled = body.handled_threads && typeof body.handled_threads === 'object' ? body.handled_threads : {};
  return { status: 'ready', platforms, totals, handledThreads: handled };
}

export function usePortalCounts(organizationId: string): {
  state: PortalCountsState;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const key = organizationId?.trim()
    ? `/api/engagement/platform-counts?${new URLSearchParams({
        organization_id: organizationId,
        organizationId: organizationId,
      }).toString()}`
    : null;
  const { data, error, isValidating, mutate } = useSWR<PortalCountsResponse>(key, {
    refreshInterval: COUNTS_REFRESH_INTERVAL_MS,
  });
  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);
  return { state: key ? readPortalCounts(data, error) : { status: 'loading' }, loading: isValidating, refresh };
}

/** Count for one tab ('all' = totals). null = unknown or still loading. */
export function getTabCount(state: PortalCountsState, slug: string): PortalTabCount | null {
  if (state.status !== 'ready') return null;
  if (slug === 'all') return state.totals;
  const canonical = slug === 'x' ? 'twitter' : slug;
  return state.platforms[canonical] ?? { needs_response: 0, people_reaction: 0, actionable_items: 0, high_priority: 0 };
}

const PLATFORM_DISPLAY: Record<string, string> = {
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  threads: 'Threads',
  whatsapp: 'WhatsApp',
};

/**
 * Why a connected platform's tab is not an engagement inbox, or null when it is.
 * Source: lib/engagementCapabilities.ts (read-only). A platform without any
 * verified inbox action (reply / like / dm) has no ingestion into this portal
 * either (TikTok, Pinterest, Threads; WhatsApp has its own inbox).
 */
export function getUnsupportedEngagementReason(platform: string): string | null {
  const slug = normalizePlatformSlug(platform);
  if (!slug || slug === 'all' || isEngagementPlatformVerified(slug)) return null;
  const label = PLATFORM_DISPLAY[slug] ?? slug;
  const row = ENGAGEMENT_CAPABILITY_MATRIX[slug as EngagementPlatform];
  const capabilityReason = row
    ? row.reply.reason ?? row.dm.reason ?? `${label} has no verified engagement action.`
    : resolveEngagementCapability(slug, 'reply').reason ?? `${label} is not a verified engagement surface.`;
  const ingestion = slug === 'whatsapp'
    ? 'WhatsApp conversations are handled in the WhatsApp inbox, not this portal.'
    : `Omnivyra does not ingest ${label} comments or messages.`;
  return `${ingestion} ${capabilityReason}`;
}
