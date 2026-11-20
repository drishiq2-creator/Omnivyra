/**
 * @jest-environment jsdom
 *
 * BlogAnalyticsPanel re-wired on /blogs/manage (owner ruling via b3, 2026-11-20; it had been orphaned since
 * bulk commits removed it from the old pages/blogs.tsx). Its honesty fixes are kept (an unavailable read is never
 * zero views). Added: a company switch resets everything (no previous company's numbers or error), late answers are
 * dropped, and the unavailable notice has a Retry that re-reads.
 *
 * SECRETS: none. No network (global fetch is mocked per URL).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import BlogAnalyticsPanel from '../../../components/blog/BlogAnalyticsPanel';
import BlogManageView from '../../../components/blog/BlogManageView';

type Answer = { status: number; body?: unknown } | 'hang';
const res = (a: Answer) =>
  a === 'hang' ? new Promise(() => {}) : Promise.resolve({ ok: a.status < 400, status: a.status, json: async () => a.body ?? {} });
const READABLE = (views: number) => ({
  status: 200,
  body: {
    total_views: views, avg_time: 40, avg_scroll: 60, top_pages: [], insights: [], period_days: 30, cold_start: false,
    delta: { views_delta: null, time_delta: null, scroll_delta: null },
  },
});
/** analytics answers per account id (queue); clusters/hot always readable. */
let byAccount: Record<string, Answer[]> = {};
beforeEach(() => {
  byAccount = {};
  (global as any).fetch = jest.fn((url: string) => {
    const acct = new URL(url, 'http://x').searchParams.get('account_id') ?? '';
    if (url.startsWith('/api/track/analytics')) {
      const q = byAccount[acct] ?? [{ status: 503 }];
      return res(q.length > 1 ? q.shift()! : q[0]);
    }
    if (url.startsWith('/api/track/clusters')) return res({ status: 200, body: { clusters: [], top_cluster: null, bottom_cluster: null } });
    if (url.startsWith('/api/track/hot')) return res({ status: 200, body: { hot: [] } });
    return res({ status: 200, body: {} });
  });
});
afterEach(() => { delete (global as any).fetch; });
const analyticsCalls = () => ((global as any).fetch as jest.Mock).mock.calls.filter(([u]: [string]) => u.startsWith('/api/track/analytics'));

describe('BlogAnalyticsPanel', () => {
  it('renders with data', async () => {
    byAccount = { 'co-a': [READABLE(12)] };
    render(<BlogAnalyticsPanel accountId="co-a" />);
    expect(await screen.findByText('Views (30d)')).toBeInTheDocument();
  });

  it('unavailable -> honest notice (not zero); Retry re-reads and shows the data', async () => {
    byAccount = { 'co-a': [{ status: 503 }, READABLE(7)] };
    render(<BlogAnalyticsPanel accountId="co-a" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not zero/i);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText('Views (30d)')).toBeInTheDocument();
    expect(analyticsCalls()).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("a company switch after an ERROR does not keep the error: company B's data shows", async () => {
    byAccount = { 'co-a': [{ status: 503 }], 'co-b': [READABLE(9)] };
    const { rerender } = render(<BlogAnalyticsPanel accountId="co-a" />);
    await screen.findByRole('alert');
    rerender(<BlogAnalyticsPanel accountId="co-b" />);
    expect(await screen.findByText('Views (30d)')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("a company switch while B is still loading shows no trace of company A's numbers", async () => {
    byAccount = { 'co-a': [READABLE(12)], 'co-b': ['hang'] };
    const { rerender } = render(<BlogAnalyticsPanel accountId="co-a" />);
    await screen.findByText('Views (30d)');
    rerender(<BlogAnalyticsPanel accountId="co-b" />);
    await act(async () => {});
    expect(screen.queryByText('Views (30d)')).not.toBeInTheDocument();
    expect(screen.getByText(/Loading analytics/)).toBeInTheDocument();
  });
});

describe('/blogs/manage renders the panel for the selected company', () => {
  const d = (companyId: string | null) => ({
    companyId, blogs: [], canManage: false, deleteId: null, deleting: false, error: null, filter: 'all', filteredBlogs: [], loading: false,
    metrics: { total: 0, drafts: 0, published: 0, views: 0 }, ga4Views: null, analyticsSummary: null, deleteAlsoRemote: false,
    setDeleteAlsoRemote: jest.fn(), setDeleteId: jest.fn(), setFilter: jest.fn(), startCreate: jest.fn(), startEdit: jest.fn(),
    confirmDelete: jest.fn(), reload: jest.fn(), publishingIssues: [], publishingIssuesError: null, retryingJobId: null,
    retryMessage: null, retryPublish: jest.fn(),
  }) as any;

  it('with a company: the panel loads analytics for that company', async () => {
    byAccount = { 'co-a': [READABLE(5)] };
    render(<BlogManageView d={d('co-a')} />);
    expect(await screen.findByText('Views (30d)')).toBeInTheDocument();
    expect(analyticsCalls()[0][0]).toContain('account_id=co-a');
  });

  it('control: no company selected -> no panel, no analytics read', async () => {
    render(<BlogManageView d={d(null)} />);
    await act(async () => {});
    expect(analyticsCalls()).toHaveLength(0);
  });
});
