/**
 * @jest-environment jsdom
 *
 * A platform-list / platform-health read failure (the routes now answer 500)
 * must render as an explicit "status unknown" state in the engagement inbox,
 * never as an empty tab list / "0 platforms" / a silently missing strip
 * (which reads as "not connected"). Each refusal test has a no-error control.
 */
import React from 'react';
import { render, screen, renderHook } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

const mockHealth = { platforms: [] as unknown[], loading: false, error: null as string | null, refresh: jest.fn(), byPlatform: jest.fn() };
jest.mock('@/hooks/useEngagementPlatformHealth', () => ({ useEngagementPlatformHealth: () => mockHealth }));
jest.mock('@/hooks/useExtensionBridge', () => ({
  useExtensionBridge: () => ({ status: null, auth: null, loading: false, error: null, refresh: jest.fn(), mergedPlatforms: [], updatingPlatform: null, authenticating: false, setBrowserPlatformEnabled: jest.fn(), authenticateExtensionViaClaimCode: jest.fn(), pollExtensionCommandsNow: jest.fn(), triggerPlatformSync: jest.fn(), executePlatformAction: jest.fn() }),
}));
jest.mock('@/hooks/useEngagementPlatformPreferences', () => ({
  useEngagementPlatformPreferences: () => ({ preferenceMap: {}, loading: false, refresh: jest.fn(), updatingPlatform: null, setPlatformEnabled: jest.fn() }),
}));
jest.mock('@/hooks/useLinkedInEngagementWorkspace', () => ({
  useLinkedInEngagementWorkspace: () => ({ overview: null, loading: false, syncing: false, error: null, lastSyncResult: null, refresh: jest.fn(), syncNow: jest.fn() }),
}));

import { PlatformTabs } from '../../../components/engagement/PlatformTabs';
import { PlatformHealthStrip } from '../../../components/engagement/PlatformHealthStrip';
import { InboxHeader } from '../../../components/engagement/inbox/InboxHeader';
import { useBrowserAssistData } from '../../../hooks/useBrowserAssist';

const tabsProps = { counts: {}, selectedPlatform: 'all', onSelectPlatform: jest.fn(), platforms: [] as string[] };

describe('PlatformTabs', () => {
  it('a connected-platforms read failure renders an explicit unknown state', () => {
    render(<PlatformTabs {...tabsProps} error="Failed to fetch integrations" />);
    expect(screen.getByRole('alert').textContent).toMatch(/couldn.t load connected platforms/i);
  });

  it('control: no error, no alert', () => {
    render(<PlatformTabs {...tabsProps} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('PlatformHealthStrip', () => {
  const stripProps = { platforms: [] as any[], selectedPlatform: 'all', organizationId: 'co-A' };

  it('a health read failure renders an explicit unknown state, not nothing', () => {
    render(<PlatformHealthStrip {...stripProps} error="Failed to fetch platform health" />);
    expect(screen.getByRole('alert').textContent).toMatch(/couldn.t check platform status/i);
  });

  it('control: no error and no platforms renders nothing', () => {
    const { container } = render(<PlatformHealthStrip {...stripProps} />);
    expect(container.textContent).toBe('');
  });
});

describe('InboxHeader platforms count', () => {
  const base = {
    browserAssist: { enabled: false, hasLinkedInConnection: false, extensionPanel: {} as any, linkedinPanel: {} as any, browserOpsPanel: {} as any },
    platformTabs: tabsProps,
    platformHealth: { platforms: [], selectedPlatform: 'all', organizationId: 'co-A' },
    onRefreshWorkspace: jest.fn(),
    onSetQueueFilter: jest.fn(),
  };
  const stats = (count: number | null) => ({ activeQueueFilter: 'all', actionableThreads: 0, connectedPlatformsCount: count, visibleThreadCount: 0, refreshDisabled: false });
  const platformsChip = () => screen.getByText('Platforms').parentElement as HTMLElement;

  it('an unknown count renders as unknown, not 0', () => {
    render(<InboxHeader {...base} queueStats={stats(null)} />);
    expect(platformsChip().textContent).not.toMatch(/0/);
    expect(platformsChip().textContent).toMatch(/—/);
  });

  it('control: a known count renders the number', () => {
    render(<InboxHeader {...base} queueStats={stats(3)} />);
    expect(platformsChip().textContent).toMatch(/3/);
  });
});

describe('useBrowserAssistData exposes the platform-health error', () => {
  it('returns platformHealthError when the health read failed', () => {
    mockHealth.error = 'Failed to fetch platform health';
    const { result } = renderHook(() => useBrowserAssistData({ organizationId: 'co-A', integrations: [], hasLinkedInConnection: false }));
    expect(result.current.platformHealthError).toBe('Failed to fetch platform health');
  });

  it('control: null when the read succeeded', () => {
    mockHealth.error = null;
    const { result } = renderHook(() => useBrowserAssistData({ organizationId: 'co-A', integrations: [], hasLinkedInConnection: false }));
    expect(result.current.platformHealthError).toBeNull();
  });
});

describe('InboxDashboard wires both errors into the header (source pin)', () => {
  const src = readFileSync(join(__dirname, '../../../components/engagement/InboxDashboard.tsx'), 'utf8');
  it('takes the integrations error, passes it to the tabs, and makes the count unknown', () => {
    expect(src).toMatch(/platforms: integrations, error: integrationsError\s*\} = useCompanyIntegrations\(/);
    expect(src).toMatch(/platformTabs=\{\{[^}]*error: integrationsError,/);
    expect(src).toMatch(/const connectedPlatformsCount = integrationsError \? null : connectedPlatformSlugs\.length;/);
  });
  it('takes the platform-health error and passes it to the strip', () => {
    expect(src).toMatch(/platformHealthError,/);
    expect(src).toMatch(/platformHealth=\{\{[^}]*error: platformHealthError,/);
  });
  it('control: the pin patterns can fail', () => {
    expect(src).not.toMatch(/platformTabs=\{\{[^}]*error: definitelyNotWired,/);
  });
});

describe('integrations read failure does not collapse the LinkedIn panel or health strip to "absent"', () => {
  const enabledAssist = (extra: Record<string, unknown>) => ({
    enabled: true,
    hasLinkedInConnection: false,
    extensionPanel: { loading: false, error: null, authenticated: false, platforms: [], onRefresh: jest.fn(), onTogglePlatform: jest.fn(async () => undefined) },
    linkedinPanel: {} as any,
    browserOpsPanel: { loading: false, authenticated: false, platforms: [], onRunBrowserAssist: jest.fn(async () => undefined) },
    ...extra,
  });
  const header = (browserAssist: any) => (
    <InboxHeader
      queueStats={{ activeQueueFilter: 'all', actionableThreads: 0, connectedPlatformsCount: 0, visibleThreadCount: 0, refreshDisabled: false }}
      browserAssist={browserAssist}
      platformTabs={tabsProps}
      platformHealth={{ platforms: [], selectedPlatform: 'all', organizationId: 'co-A' }}
      onRefreshWorkspace={jest.fn()}
      onSetQueueFilter={jest.fn()}
    />
  );

  it('LinkedIn connection unknown renders an unknown notice, not nothing', () => {
    render(header(enabledAssist({ linkedInConnectionUnknown: true })));
    const alerts = screen.queryAllByRole('alert').map((a) => a.textContent ?? '');
    expect(alerts.some((t) => /linkedin/i.test(t) && /unknown/i.test(t))).toBe(true);
  });

  it('control: LinkedIn genuinely not connected renders no LinkedIn notice', () => {
    render(header(enabledAssist({ linkedInConnectionUnknown: false })));
    const alerts = screen.queryAllByRole('alert').map((a) => a.textContent ?? '');
    expect(alerts.some((t) => /linkedin/i.test(t))).toBe(false);
  });

  const { selectVisiblePlatformHealth } = require('../../../components/engagement/inbox/helpers');
  const rows = [{ platform: 'linkedin' }, { platform: 'facebook' }];
  const norm = (p: string) => p;

  it('connected list unknown: every health row is shown (not filtered to nothing)', () => {
    expect(selectVisiblePlatformHealth(rows, new Set<string>(), true, norm)).toEqual(rows);
  });

  it('control: connected list known: health is filtered to connected platforms', () => {
    expect(selectVisiblePlatformHealth(rows, new Set(['facebook']), false, norm)).toEqual([{ platform: 'facebook' }]);
    expect(selectVisiblePlatformHealth(rows, new Set<string>(), false, norm)).toEqual([]);
  });

  it('InboxDashboard uses the helper and passes the unknown flag (source pin, with a failing control)', () => {
    const src = readFileSync(join(__dirname, '../../../components/engagement/InboxDashboard.tsx'), 'utf8');
    expect(src).toMatch(/selectVisiblePlatformHealth\(platformHealth, connectedPlatformSet, Boolean\(integrationsError\), normalizePlatform\)/);
    expect(src).toMatch(/linkedInConnectionUnknown: Boolean\(integrationsError\),/);
    expect(src).not.toMatch(/linkedInConnectionUnknown: definitelyNotWired/);
  });
});
