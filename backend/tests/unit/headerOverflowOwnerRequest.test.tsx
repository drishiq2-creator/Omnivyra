/**
 * @jest-environment jsdom
 *
 * Owner request 2026-11-20 (via b3): at common laptop widths the header overflowed and the profile avatar was hidden
 * behind the scrollbar. Now menus that don't fit fold into "More ▾"; Company / Credits / Avatar never fold.
 * Plus: "Web & Capture" left the header for an admin-only "Website & lead capture" section on the Command Center.
 *
 * jsdom has no layout, so widths are stubbed: offsetWidth per measured element and the nav's clientWidth per
 * viewport. Real pixel rendering at 1280/1440/1920 needs a browser (stated in the review ask).
 */
import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { fitNavItems } from '../../../lib/nav/fitNavItems';

let pathname = '/dashboard';
let role = 'COMPANY_ADMIN';
jest.mock('next/router', () => ({ useRouter: () => ({ pathname, asPath: pathname, push: jest.fn() }) }));
jest.mock('next/link', () => function MockLink({ href, children, ...p }: any) { return <a href={href} {...p}>{children}</a>; });
jest.mock('../../../components/CompanyContext', () => ({
  useCompanyContext: () => ({ userName: 'Kai', selectedCompanyId: 'company-1', userRole: role, isAuthenticated: true }),
}));
jest.mock('@/hooks/useCredits', () => ({ useCredits: () => ({ totalCredits: 100, remainingCredits: 80 }) }));
jest.mock('../../../components/tour/TourContext', () => ({ useTour: () => ({ startTour: jest.fn() }) }));
jest.mock('../../../components/tour/TourOverlay', () => ({ TourOverlay: () => null }));
jest.mock('../../../components/NotificationBell', () => ({ NotificationBell: () => <div data-testid="notification-bell" /> }));

import GlobalHeader from '../../../components/layout/GlobalHeader';
import WebsiteLeadCaptureSection from '../../../components/command-center/WebsiteLeadCaptureSection';
import { WEBSITE_LEAD_CAPTURE_LINKS } from '../../../lib/nav/websiteLeadCapture';

/* Measured widths, approximating the real header (icon + label + chevron + padding). */
const ITEM_WIDTH: Record<string, number> = { Reports: 118, Content: 116, Campaigns: 138, Engagement: 146, Prospect: 124 };
const HOME = 40; const MORE = 96; const GAP = 4;
/** Nav inner width by viewport: container min(V - 17px scrollbar, 1280) minus px-6, logo, divider and the right cluster. */
const navWidthFor = (viewport: number) => Math.min(viewport - 17, 1280) - 48 - 116 - 13 - 420;

let navWidth = 2000;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const kind = this.getAttribute('data-nav-measure');
      if (kind === 'home') return HOME;
      if (kind === 'more') return MORE;
      if (kind === 'item') return ITEM_WIDTH[(this.textContent || '').trim()] ?? 120;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.getAttribute('data-testid') === 'header-nav' ? navWidth : 0; },
  });
});

describe('fitNavItems (pure)', () => {
  const widths = Object.values(ITEM_WIDTH);
  it('everything fits → all items, no More', () => {
    expect(fitNavItems(10_000, widths, MORE, GAP)).toBe(widths.length);
  });
  it('a narrow nav keeps room for More and folds the rest', () => {
    const n = fitNavItems(400, widths, MORE, GAP);
    const used = widths.slice(0, n).reduce((s, w) => s + w, 0) + GAP * Math.max(0, n - 1);
    expect(n).toBeLessThan(widths.length);
    expect(used + GAP + MORE).toBeLessThanOrEqual(400);
  });
  it('never negative; an empty nav is 0', () => {
    expect(fitNavItems(0, widths, MORE, GAP)).toBe(0);
    expect(fitNavItems(500, [], MORE, GAP)).toBe(0);
  });
});

describe.each([1280, 1440, 1920, 1100])('header at %ipx', (viewport) => {
  it('the avatar menu and credits are always rendered; anything that does not fit is in "More"', async () => {
    navWidth = navWidthFor(viewport) - HOME - GAP > 0 ? navWidthFor(viewport) : 0;
    await act(async () => { render(<GlobalHeader />); });
    // The right-hand cluster is never folded: the credits pill and the user menu trigger exist at every width.
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
    const avail = Math.max(0, navWidth - HOME - GAP);
    const expectedVisible = fitNavItems(avail, Object.values(ITEM_WIDTH), MORE, GAP);
    const more = screen.queryAllByRole('button').find((b) => /^\s*More/.test(b.textContent || ''));
    if (expectedVisible < Object.keys(ITEM_WIDTH).length) {
      expect(more).toBeDefined();
    } else {
      expect(more).toBeUndefined();
    }
  });
});

it('"More" lists the folded menus\' items, grouped under their menu name', async () => {
  navWidth = 360; // forces folding
  await act(async () => { render(<GlobalHeader />); });
  const more = screen.getAllByRole('button').find((b) => /^\s*More/.test(b.textContent || ''))!;
  await act(async () => { fireEvent.click(more); });
  // Prospect is the last menu, so it folds first; its items are reachable through More.
  expect(screen.getByText('Prospect', { selector: 'div' })).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /Active Leads/ }).length).toBeGreaterThan(0);
});

describe('structure: the nav can shrink, the right cluster cannot (the hidden-avatar cause)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../components/layout/GlobalHeaderMain.tsx'), 'utf8');
  it('the nav is min-w-0 (it used to be flex-1 without it, so it could not shrink)', () => {
    expect(src).toMatch(/<nav ref=\{navRef\} className="[^"]*\bmin-w-0\b[^"]*\bflex-1\b/);
  });
  it('the right-hand cluster is shrink-0', () => {
    expect(src).toMatch(/<div className="ml-auto flex shrink-0 items-center gap-2">/);
  });
});

describe('Command Center: "Website & lead capture" (admins only)', () => {
  it('a company admin sees all five links, same routes as the old menu', () => {
    render(<WebsiteLeadCaptureSection userRole="COMPANY_ADMIN" />);
    for (const l of WEBSITE_LEAD_CAPTURE_LINKS) expect(screen.getByRole('link', { name: new RegExp(l.label) })).toHaveAttribute('href', l.href);
  });
  it.each(['CONTENT_CREATOR', 'VIEW_ONLY', '', null])('a non-admin (%s) does not see it', (r) => {
    render(<WebsiteLeadCaptureSection userRole={r as any} />);
    expect(screen.queryByTestId('website-lead-capture-section')).toBeNull();
  });
  it('the header no longer has a "Web & Capture" menu', async () => {
    navWidth = 2000;
    await act(async () => { render(<GlobalHeader />); });
    expect(screen.queryByText('Web & Capture')).toBeNull();
  });
});
