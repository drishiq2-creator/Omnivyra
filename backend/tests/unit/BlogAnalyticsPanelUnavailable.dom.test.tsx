/**
 * @jest-environment jsdom
 *
 * When /api/track/analytics cannot read its data (503 ANALYTICS_UNAVAILABLE), the panel SAYS the
 * analytics are unavailable - it does not vanish, and it never shows zero views (e9, 2026-11-12).
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import BlogAnalyticsPanel from '../../../components/blog/BlogAnalyticsPanel';

const json = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body });

function stubFetch(
  analytics: () => Promise<unknown>,
  sections: { clusters?: () => Promise<unknown>; hot?: () => Promise<unknown> } = {},
) {
  (global as any).fetch = jest.fn((url: string) => {
    if (url.startsWith('/api/track/analytics')) return analytics();
    if (url.startsWith('/api/track/clusters')) return sections.clusters ? sections.clusters() : json(200, { clusters: [], top_cluster: null, bottom_cluster: null });
    if (url.startsWith('/api/track/hot')) return sections.hot ? sections.hot() : json(200, { hot: [] });
    // Non-ok on purpose: these tests COUNT the call; a body the result view cannot render would crash the
    // control on the old code for a fixture reason instead of failing on the call itself.
    if (url.startsWith('/api/track/ai-insights')) return json(500, {});
    return json(200, {});
  });
}

afterEach(() => { delete (global as any).fetch; });

// The route answers 503 since b3's read-failure rule (2026-11-19); 500 is kept: the panel must not depend on the number.
it.each([503, 500])('analytics %s -> an "unavailable" alert, no numbers', async (status) => {
  stubFetch(() => json(status, { code: 'ANALYTICS_UNAVAILABLE', error: 'Blog analytics are temporarily unavailable.' }));
  render(<BlogAnalyticsPanel accountId="co-a" />);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/temporarily unavailable/i);
  expect(alert).toHaveTextContent(/not zero/i);
  expect(screen.queryByText('Views (30d)')).not.toBeInTheDocument();
});

it('network failure -> the same "unavailable" alert', async () => {
  stubFetch(() => Promise.reject(new Error('offline')));
  render(<BlogAnalyticsPanel accountId="co-a" />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
});

it('NEGATIVE CONTROL: analytics readable (cold start) -> no unavailable alert', async () => {
  stubFetch(() => json(200, {
    total_views: 0, avg_time: 0, avg_scroll: 0, top_pages: [], insights: [], period_days: 30, cold_start: true,
    delta: { views_delta: null, time_delta: null, scroll_delta: null },
  }));
  render(<BlogAnalyticsPanel accountId="co-a" />);
  expect(await screen.findByText(/Waiting for your first visitors/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

// ---- a section whose read failed is UNAVAILABLE, never empty (b3 standing rule, 2026-11-19) ----
const READABLE = () => json(200, {
  total_views: 12, avg_time: 40, avg_scroll: 60, top_pages: [], insights: [], period_days: 30, cold_start: false,
  delta: { views_delta: null, time_delta: null, scroll_delta: null },
});
const aiCalls = () => ((global as any).fetch as jest.Mock).mock.calls.filter(([u]: [string]) => String(u).startsWith('/api/track/ai-insights'));

it.each([
  ['clusters 503', { clusters: () => json(503, { code: 'CLUSTERS_UNAVAILABLE' }) }, /content clusters/i],
  ['clusters network failure', { clusters: () => Promise.reject(new Error('offline')) }, /content clusters/i],
  ['hot 503', { hot: () => json(503, { code: 'HOT_UNAVAILABLE' }) }, /trending posts/i],
  ['hot network failure', { hot: () => Promise.reject(new Error('offline')) }, /trending posts/i],
] as const)('%s -> the section says it could not be checked; the rest of the panel still renders', async (_n, sections, says) => {
  stubFetch(READABLE, sections as any);
  render(<BlogAnalyticsPanel accountId="co-a" />);
  const notice = await screen.findByRole('status');
  expect(notice).toHaveTextContent(says);
  expect(notice).toHaveTextContent(/doesn.t mean there are none/i);
  expect(screen.getByText('Views (30d)')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('a section unavailable -> AI insights are NOT generated from its empty list, and the panel says why', async () => {
  stubFetch(READABLE, { clusters: () => json(503, { code: 'CLUSTERS_UNAVAILABLE' }) });
  render(<BlogAnalyticsPanel accountId="co-a" />);
  fireEvent.click(await screen.findByText(/AI Strategy Insights/i));
  expect(aiCalls()).toHaveLength(0); // first: the old code fires the request synchronously in the click
  expect(await screen.findByText(/weren.t generated from incomplete data/i)).toBeInTheDocument();
});

it('NEGATIVE CONTROL: every section readable -> no notice, and AI insights ARE requested', async () => {
  stubFetch(READABLE);
  render(<BlogAnalyticsPanel accountId="co-a" />);
  fireEvent.click(await screen.findByText(/AI Strategy Insights/i));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(aiCalls()).toHaveLength(1);
});
