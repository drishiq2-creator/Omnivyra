/**
 * @jest-environment jsdom
 *
 * Blog cost UI (owner ruling via b3, 2026-11-18): a blog costs a fixed 40 credits. The screen
 * shows the catalog price BEFORE "Write This", a 402 reads as plain "not enough credits" with the
 * buy-credits path, a failure on our side says "you weren't charged", and a 2xx whose charge is
 * still settling keeps its note on screen until the user moves on (7c).
 * Shapes: c6, feat/blog-fixed-40-20261118 @30bb91d90 (500 = billing{charged:0, released:40,
 * reason:'failed'}; 'partial'/'not_started' no longer exist; 402 carries `available` only).
 */
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = jest.fn();
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import RunCostLine, { runCostText } from '../../../components/billing/RunCostLine';
import BlogGenerateModal, { generateFailureMessage, BILLED_NETWORK_UNCERTAIN } from '../../../components/blog/BlogGenerateModalMain';
import { UNCERTAIN_MESSAGE, SETTLEMENT_PENDING_MESSAGE } from '../../../lib/billing/billedResponse';

const BLOG = { actionKey: 'blog_post', minCredits: 40, maxCredits: 40, expectedCredits: 40, tokenPriced: false, source: 'credit_cost_config' };
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const keyOf = (init: unknown): string | undefined => ((init as { headers?: Record<string, string> })?.headers ?? {})['Idempotency-Key'];
const FAILED = { ok: false, error: 'Generation failed', billing: { charged: 0, released: 40, reason: 'failed' } };

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue(reply(200, { ranges: [BLOG], unknown: [] }));
});

describe('the price line says "This blog uses 40 credits"', () => {
  it('pure text; the default noun keeps Market Pulse unchanged', () => {
    expect(runCostText({ range: BLOG, quantity: 1, unit: 'blog', unitPlural: 'blogs', noun: 'blog' })).toBe('This blog uses 40 credits.');
    expect(runCostText({ range: BLOG, quantity: 1, unit: 'blog', unitPlural: 'blogs' })).toBe('This run uses 40 credits.');
  });
  it('rendered from the catalog for blog_post', async () => {
    render(<RunCostLine companyId="c1" actionKey="blog_post" quantity={1} unit="blog" unitPlural="blogs" noun="blog" />);
    expect(await screen.findByText('This blog uses 40 credits.')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/billing/activity-cost-range?companyId=c1&actions=blog_post');
  });
  it('blog_post not priced yet (before migration 058) -> price unavailable, never a guess', async () => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValueOnce(reply(200, { ranges: [], unknown: ['blog_post'] }));
    render(<RunCostLine companyId="c1" actionKey="blog_post" quantity={1} unit="blog" unitPlural="blogs" noun="blog" />);
    expect(await screen.findByText('Price unavailable right now.')).toBeInTheDocument();
  });
});

describe('generateFailureMessage (billed blog, c6 @30bb91d90 shapes)', () => {
  const billed = (status: number, data: Record<string, unknown>, report: { failures: string[] } | null = null) =>
    generateFailureMessage({ billed: true, status, data, report: report as never });

  it('402 -> plain "not enough credits" + the numbers + the buy-credits path', () => {
    expect(billed(402, { ok: false, code: 'INSUFFICIENT_CREDITS', retryable: false, error: 'Not enough credits to generate this blog.', required: 40, available: 12 }))
      .toBe('Not enough credits to generate this blog. (40 credits are reserved up front; you’ll only be charged for what’s used. You have 12). Top up credits on the Billing page.');
  });
  it('500 failed (charged 0, released 40) -> you weren’t charged', () => {
    expect(billed(500, FAILED)).toBe('Generation failed. You weren’t charged.');
  });
  it('500 with no billing facts -> "not sure", never a plain failure', () => {
    expect(billed(500, { error: 'boom' })).toBe(UNCERTAIN_MESSAGE);
  });
  it('503 switch unreadable is NOT "not sure": nothing started, try again', () => {
    expect(billed(503, { code: 'BLOG_SWITCH_UNAVAILABLE', retryable: true, error: 'Blog generation is temporarily unavailable. Please try again.' }))
      .toBe('Blog generation is temporarily unavailable. Please try again.');
  });
  it('409 in progress -> b3’s line', () => {
    expect(billed(409, { code: 'BLOG_ALREADY_IN_PROGRESS', error: 'This blog is already being generated.' })).toBe('This blog is already being written.');
  });
  it('422 quality refund keeps the gate reasons AND says you weren’t charged', () => {
    expect(billed(422, { error: 'quality', billing: { charged: 0, released: 40, reason: 'quality_refund' } }, { failures: ['thin body', 'duplicate'] }))
      .toBe('Quality gate blocked this draft: thin body; duplicate This didn’t pass our quality check, so you weren’t charged.');
  });
  it('non-billed types keep their raw text', () => {
    const plain = (status: number, data: Record<string, unknown>) => generateFailureMessage({ billed: false, status, data, report: null });
    expect(plain(402, { error: 'whatever', code: 'INSUFFICIENT_CREDITS' })).toBe('whatever');
    expect(plain(500, {})).toBe('Generation failed.');
  });
});

describe('BlogGenerateModal (rendered)', () => {
  const ANGLES = { angles: [{ type: 'analytical', label: 'Analytical', title: 'Angle title', angle_summary: 's', hook: 'h' }] };

  async function toWriteStep(contentType: 'blog' | 'article', topic: string, fullReplies: Array<unknown>) {
    const endpoint = contentType === 'blog' ? '/api/blogs/generate' : '/api/articles/generate';
    const full: unknown[] = [];
    const onGenerated = jest.fn(async () => {});
    (global as { fetch?: unknown }).fetch = jest.fn(async (url: string, init: { body?: string }) => {
      if (url === endpoint && JSON.parse(init.body ?? '{}').mode === 'angles') return reply(200, ANGLES);
      if (url === endpoint) {
        full.push(init);
        const next = fullReplies.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return reply(200, {});
    });
    render(<BlogGenerateModal companyId="c1" initialTopic={topic} contentType={contentType} onClose={() => {}} onGenerated={onGenerated} />);
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(await screen.findByText('Angle title'));
    return { full, onGenerated, write: () => screen.getByRole('button', { name: /Write This/ }) };
  }

  it('cost line and billing share ONE condition: a blog shows the price AND sends a key; an article neither', async () => {
    const blog = await toWriteStep('blog', 'C-blog', [reply(200, { result: { title: 't' } })]);
    expect(await screen.findByText('This blog uses 40 credits.')).toBeInTheDocument();
    fireEvent.click(blog.write());
    await waitFor(() => expect(blog.full).toHaveLength(1));
    expect((keyOf(blog.full[0]) ?? '').length).toBeGreaterThanOrEqual(8);
    document.body.innerHTML = '';

    const article = await toWriteStep('article', 'C-article', [reply(200, { result: { title: 't' } })]);
    expect(screen.queryByTestId('run-cost-blog_post')).toBeNull();
    fireEvent.click(article.write());
    await waitFor(() => expect(article.full).toHaveLength(1));
    expect(keyOf(article.full[0])).toBeUndefined();
  });

  it('a failure stating its billing -> "you weren’t charged" on screen, and the next click is a NEW request', async () => {
    const { full, write } = await toWriteStep('blog', 'C-failed', [reply(500, FAILED), reply(200, { result: { title: 't' } })]);
    fireEvent.click(write());
    expect(await screen.findByText(/Generation failed\. You weren’t charged\./)).toBeInTheDocument();
    fireEvent.click(write());
    await waitFor(() => expect(full).toHaveLength(2));
    expect(keyOf(full[1])).not.toBe(keyOf(full[0]));
  });

  it('lost connection -> the uncertain line, and the retry reuses the key', async () => {
    const { full, write } = await toWriteStep('blog', 'C-lost', [new TypeError('Failed to fetch'), reply(200, { result: { title: 't' } })]);
    fireEvent.click(write());
    expect(await screen.findByText(new RegExp(BILLED_NETWORK_UNCERTAIN.slice(0, 30)))).toBeInTheDocument();
    fireEvent.click(write());
    await waitFor(() => expect(full).toHaveLength(2));
    expect(keyOf(full[1])).toBe(keyOf(full[0]));
  });

  it('settlementPending: the editor does NOT auto-open; the note stays until the user clicks; no re-run', async () => {
    const { full, write, onGenerated } = await toWriteStep('blog', 'C-pending', [
      reply(200, { result: { title: 'Draft' }, billing: { charged: 40, released: 0, reason: 'completed' }, settlementPending: { code: 'CREDIT_SETTLE_AMBIGUOUS' } }),
    ]);
    fireEvent.click(write());
    expect(await screen.findByText(SETTLEMENT_PENDING_MESSAGE)).toBeInTheDocument();
    expect(onGenerated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Open the editor/ }));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
    expect((onGenerated.mock.calls[0] as unknown[])[0]).toMatchObject({ title: 'Draft' });
    expect(full).toHaveLength(1);
  });

  it('control: a plain 2xx opens the editor straight away (no hold)', async () => {
    const { write, onGenerated } = await toWriteStep('blog', 'C-ok', [reply(200, { result: { title: 'Draft' }, billing: { charged: 40, released: 0, reason: 'completed' } })]);
    fireEvent.click(write());
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /Open the editor/ })).toBeNull();
  });
});
