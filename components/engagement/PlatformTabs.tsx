/**
 * PlatformTabs — platform tabs with activity badges.
 *
 * E4: every badge is a SERVER count (engagement-portal-counts.v1, served by
 * /api/engagement/platform-counts) — actionable items per platform, computed
 * for all platforms at once, so the badges do not depend on the selected tab.
 *  - counts unavailable → "—" on every tab plus one alert (unknown, never 0);
 *  - a connected platform with no engagement support → "n/a" with its reason.
 * Color: high_priority > 0 → red; actionable > 0 → amber.
 * Uses dynamic platforms from company integrations when provided; otherwise shows All only.
 */

import React from 'react';
import PlatformIcon from '@/components/ui/PlatformIcon';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getPlatformLabel } from '@/utils/platformIcons';
import { VERIFIED_ENGAGEMENT_PLATFORMS } from '@/lib/engagementCapabilities';
import type { PortalTabCount } from './portalCounts';

/** Canonical order for known platforms when displayed dynamically. */
const PLATFORM_ORDER = [
  'linkedin',
  'twitter',
  'instagram',
  'facebook',
  'youtube',
  'reddit',
  'pinterest',
  'tiktok',
  'threads',
] as const;

function normalizeToCanonicalSlug(p: string): string {
  const lower = (p || '').toLowerCase().trim();
  if (lower === 'x') return 'twitter';
  return lower || 'unknown';
}

function buildTabItems(integratedPlatforms: string[]): Array<{ slug: string; label: string }> {
  const allTab = { slug: 'all', label: 'All' };
  if (!integratedPlatforms.length) return [allTab];
  const normalized = [
    ...new Set(
      integratedPlatforms
        .map(normalizeToCanonicalSlug)
        .filter((s) => s !== 'unknown')
    ),
  ];
  const ordered = normalized.sort((a, b) => {
    const ia = PLATFORM_ORDER.indexOf(a as typeof PLATFORM_ORDER[number]);
    const ib = PLATFORM_ORDER.indexOf(b as typeof PLATFORM_ORDER[number]);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  return [allTab, ...ordered.map((slug) => ({ slug, label: getPlatformLabel(slug) || slug }))];
}

function getBadgeAccent(count: PortalTabCount | null): string {
  if (!count) return 'border-l-transparent';
  if (count.high_priority > 0) return 'border-l-red-500';
  if (count.actionable_items > 0) return 'border-l-amber-500';
  return 'border-l-transparent';
}

/** Fallback when no integrations prop is passed: only platforms that have at
 *  least one verified engagement action. No "coming soon" placeholders. */
const FALLBACK_PLATFORM_SLUGS = [...VERIFIED_ENGAGEMENT_PLATFORMS];

export interface PlatformTabsProps {
  /**
   * Server count per tab slug ('all' = totals). null = unknown (failed read)
   * or not loaded yet; see `countsUnavailable`.
   */
  getCount: (slug: string) => PortalTabCount | null;
  /** True when the server count read failed: show "—" and an alert. */
  countsUnavailable?: boolean;
  onRetryCounts?: () => void;
  /** slug → reason, for connected platforms without engagement support. */
  unsupportedReasons?: Record<string, string>;
  selectedPlatform: string;
  onSelectPlatform: (platform: string) => void;
  /** Configured platform slugs for company. When provided, only these + All shown. When empty [], only All. */
  platforms?: string[];
  loading?: boolean;
  className?: string;
}

export const PlatformTabs = React.memo(function PlatformTabs({
  getCount,
  countsUnavailable = false,
  onRetryCounts,
  unsupportedReasons = {},
  selectedPlatform,
  onSelectPlatform,
  platforms: integratedPlatforms,
  loading = false,
  className = '',
}: PlatformTabsProps) {
  const platformsToShow =
    integratedPlatforms !== undefined ? integratedPlatforms : FALLBACK_PLATFORM_SLUGS;
  const tabItems = buildTabItems(platformsToShow);

  return (
    <div className={className}>
      <Tabs value={selectedPlatform} onValueChange={onSelectPlatform}>
        <TabsList className="flex flex-wrap gap-1 h-auto p-1">
          {tabItems.map(({ slug, label }) => {
            const unsupportedReason = slug !== 'all' ? unsupportedReasons[slug] ?? null : null;
            const count = countsUnavailable ? null : getCount(slug);
            const accentColor = getBadgeAccent(count);
            const isActive = selectedPlatform === slug;
            const actionable = count?.actionable_items ?? 0;
            return (
              <TabsTrigger
                key={slug}
                value={slug}
                className={`flex items-center gap-2 px-3 py-2 border-l-2 ${isActive ? accentColor : 'border-l-transparent'}`}
              >
                <span
                  data-testid={`platform-tab-${slug}`}
                  title={unsupportedReason
                    ? `Not supported: ${unsupportedReason}`
                    : count
                      ? `${count.needs_response} need response · ${count.people_reaction} reactions`
                      : countsUnavailable ? 'Count unavailable' : undefined}
                  className="flex items-center gap-2"
                >
                {slug && slug !== 'all' ? <PlatformIcon platform={slug} size={14} /> : null}
                <span>{label}</span>
                {unsupportedReason ? (
                  <span data-testid={`platform-tab-badge-${slug}`} className="text-[10px] font-semibold uppercase text-slate-400">
                    n/a
                  </span>
                ) : countsUnavailable ? (
                  <span
                    data-testid={`platform-tab-badge-${slug}`}
                    aria-label="Count unavailable"
                    className="inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] font-bold text-slate-600 bg-slate-200 rounded-full px-1"
                  >
                    —
                  </span>
                ) : actionable > 0 ? (
                  <span
                    data-testid={`platform-tab-badge-${slug}`}
                    className="inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] font-bold text-white bg-amber-500 rounded-full px-1"
                  >
                    {actionable > 99 ? '99+' : actionable}
                  </span>
                ) : null}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
      {countsUnavailable && (
        <div
          role="alert"
          data-testid="platform-counts-unavailable"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <span>Activity counts could not be loaded. A "—" means unknown, not zero.</span>
          {onRetryCounts ? (
            <button type="button" onClick={onRetryCounts} className="font-semibold underline">
              Retry
            </button>
          ) : null}
        </div>
      )}
      {loading && <div className="h-1 bg-slate-100 rounded animate-pulse mt-2" />}
    </div>
  );
});
