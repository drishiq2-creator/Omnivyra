/**
 * @jest-environment jsdom
 *
 * E4 — the portal renders SERVER counts: unknown on a failed read ("—" + alert,
 * never 0), the same badges whatever tab is selected, and an explicit
 * "not supported: <reason>" for connected platforms without engagement support.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SWRConfig } from 'swr';

const mockApiFetch = jest.fn();
jest.mock('../../../lib/apiFetch', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
jest.mock('../../../components/ui/PlatformIcon', () => ({ __esModule: true, default: () => null }));

import { SWR_GLOBAL_CONFIG } from '../../../lib/swr/swrClient';
import { PlatformTabs } from '../../../components/engagement/PlatformTabs';
import {
  getTabCount,
  getUnsupportedEngagementReason,
  readPortalCounts,
  usePortalCounts,
  type PortalCountsState,
} from '../../../components/engagement/portalCounts';

const c = (needs: number, reactions: number, high = 0) => ({
  needs_response: needs, people_reaction: reactions, actionable_items: needs + reactions, high_priority: high,
});
const body = {
  definition: 'engagement-portal-counts.v1',
  counts: { linkedin: c(12, 3), twitter: c(0, 2) },
  totals: c(12, 5),
  handled_threads: {},
};
const ready = readPortalCounts(body, undefined);

function renderTabs(state: PortalCountsState, selectedPlatform: string, extra: Partial<React.ComponentProps<typeof PlatformTabs>> = {}) {
  return render(
    <PlatformTabs
      getCount={(slug) => getTabCount(state, slug)}
      countsUnavailable={state.status === 'unknown'}
      selectedPlatform={selectedPlatform}
      onSelectPlatform={() => {}}
      platforms={['linkedin', 'twitter']}
      {...extra}
    />,
  );
}
const badge = (slug: string) => screen.queryByTestId(`platform-tab-badge-${slug}`)?.textContent ?? null;

describe('tab badges are server counts', () => {
  it('shows the true totals (12 + 3 on LinkedIn, beyond the 10-item visible list)', () => {
    renderTabs(ready, 'all');
    expect(badge('linkedin')).toBe('15');
    expect(badge('twitter')).toBe('2');
    expect(badge('all')).toBe('17');
  });

  it('badges are identical whichever tab is selected', () => {
    const seen = ['all', 'linkedin', 'twitter'].map((sel) => {
      const { unmount } = renderTabs(ready, sel);
      const out = [badge('all'), badge('linkedin'), badge('twitter')];
      unmount();
      return out;
    });
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(seen[0]).toEqual(['17', '15', '2']);
  });
});

describe('read failure → unknown, never 0', () => {
  it('an unknown state renders "—" on every tab plus an alert', () => {
    renderTabs({ status: 'unknown', error: 'boom' }, 'all');
    expect(badge('all')).toBe('—');
    expect(badge('linkedin')).toBe('—');
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('CONTROL: a real zero is "no badge", no dash and no alert', () => {
    renderTabs(readPortalCounts({ ...body, counts: { linkedin: c(0, 0) }, totals: c(0, 0) }, undefined), 'all');
    expect(badge('linkedin')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['an error', undefined, new Error('503')],
    ['a body without totals', { counts: {} }, undefined],
    ['an empty body', {}, undefined],
    ['a negative count', { ...body, totals: c(-1, 0) }, undefined],
  ])('readPortalCounts: %s → unknown', (_n, data, error) => {
    expect(readPortalCounts(data, error).status).toBe('unknown');
  });

  it('CONTROL: a complete body → ready', () => {
    expect(ready.status).toBe('ready');
  });

  const harness = (children: React.ReactNode) => (
    <SWRConfig value={{ ...SWR_GLOBAL_CONFIG, provider: () => new Map(), dedupingInterval: 0, onErrorRetry: () => {} }}>
      {children}
    </SWRConfig>
  );
  function Probe() {
    const { state } = usePortalCounts('org-1');
    return <span data-testid="state">{state.status === 'ready' ? `ready:${state.totals.actionable_items}` : state.status}</span>;
  }
  const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b });

  it('usePortalCounts: a 503 from the counts route is unknown', async () => {
    mockApiFetch.mockResolvedValue(json({ code: 'ENGAGEMENT_COUNTS_UNAVAILABLE' }, 503));
    render(harness(<Probe />));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('unknown'));
  });

  it('CONTROL: usePortalCounts: a 200 is ready with the server number', async () => {
    mockApiFetch.mockResolvedValue(json(body));
    render(harness(<Probe />));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ready:17'));
  });
});

describe('unsupported platform tab', () => {
  it('TikTok and Pinterest carry an explicit reason from the capability matrix', () => {
    const tiktok = getUnsupportedEngagementReason('tiktok');
    const pinterest = getUnsupportedEngagementReason('pinterest');
    expect(tiktok).toMatch(/does not ingest TikTok/);
    expect(tiktok).toMatch(/TikTok does not expose comment reply via public API/);
    expect(pinterest).toMatch(/Pinterest/);
    expect(getUnsupportedEngagementReason('threads')).toMatch(/not a verified engagement surface/);
  });

  it('CONTROL: supported platforms have no reason', () => {
    for (const p of ['linkedin', 'twitter', 'x', 'facebook', 'instagram', 'youtube', 'reddit']) {
      expect(getUnsupportedEngagementReason(p)).toBeNull();
    }
  });

  it('the tab shows "n/a" with "Not supported: <reason>", not an actionable count', () => {
    const reason = getUnsupportedEngagementReason('tiktok')!;
    renderTabs(ready, 'tiktok', { platforms: ['linkedin', 'tiktok'], unsupportedReasons: { tiktok: reason } });
    expect(badge('tiktok')).toBe('n/a');
    expect(screen.getByTestId('platform-tab-tiktok').getAttribute('title')).toBe(`Not supported: ${reason}`);
    expect(badge('linkedin')).toBe('15'); // CONTROL: a supported neighbour keeps its count
  });
});

describe('source contract: InboxDashboard no longer derives badges in the browser', () => {
  const src = readFileSync(join(__dirname, '../../../components/engagement/InboxDashboard.tsx'), 'utf8');
  const derivesBadgesClientSide = (s: string) =>
    /counts:\s*platformCounts/.test(s) || /workQueue:\s*clientWorkQueue/.test(s) || /usePlatformCounts\(/.test(s);
  const usesServerCounts = (s: string) =>
    /getCount:\s*\(slug: string\) => getTabCount\(portalCounts, slug\)/.test(s)
    && /selectNeedsResponseThreads\(filteredItems, undefined, handledThreads\)/.test(s)
    && /selectPeopleReactionThreads\(filteredItems, undefined, handledThreads\)/.test(s)
    && /data-testid="platform-unsupported-state"/.test(s);

  it('passes the server counts and the handled map, and renders the unsupported state', () => {
    expect(derivesBadgesClientSide(src)).toBe(false);
    expect(usesServerCounts(src)).toBe(true);
  });

  it('CONTROL: the pre-E4 wiring fails the same pin', () => {
    const before = "platformTabs={{ counts: platformCounts, workQueue: clientWorkQueue as typeof workQueue }} usePlatformCounts(organizationId)";
    expect(derivesBadgesClientSide(before)).toBe(true);
    expect(usesServerCounts(before)).toBe(false);
  });
});
