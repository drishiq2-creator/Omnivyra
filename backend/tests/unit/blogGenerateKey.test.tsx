/**
 * @jest-environment jsdom
 *
 * Blog Idempotency-Key on ALL THREE blog callers (c6, feat/blog-fixed-40-20261118 @30bb91d90: the
 * key is REQUIRED, 400 IDEMPOTENCY_KEY_REQUIRED without one; b3: this merges BEFORE c6's branch).
 * Behavioural: each caller is rendered and clicked, and the header on the real request is read.
 *
 * Key lifetime (lib/blog/blogGenerateKey): a known outcome ends the key (the next click is a new
 * request); an unknown outcome keeps it (the next click reuses it, so the server can answer
 * "already being written" instead of holding a second 40 credits).
 */
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── shared mocks ────────────────────────────────────────────────────────────
const routerState: { query: Record<string, string>; isReady: boolean; push: jest.Mock } = { query: {}, isReady: true, push: jest.fn() };
jest.mock('next/router', () => ({ useRouter: () => routerState }));
jest.mock('next/head', () => ({ __esModule: true, default: () => null }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock('../../../components/CompanyContext', () => ({
  useCompanyContext: () => ({ user: { userId: 'u1' }, selectedCompanyId: 'c1', isLoading: false }),
}));
jest.mock('../../../components/content/GenerationProgressTracker', () => ({ __esModule: true, default: () => null }));
const fetchWithAuth = jest.fn();
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { blogGenerateKeys, blogKeyScope, blogRefusalText, keepBlogKey, BLOG_IN_PROGRESS_TEXT } from '../../../lib/blog/blogGenerateKey';
import BlogSuggestionsPage from '../../../pages/blogs/suggestions';
import ContentRefinePage from '../../../pages/admin/blog/content-refine';
import BlogGenerateModal from '../../../components/blog/BlogGenerateModal';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const keyOf = (init: unknown): string | undefined => ((init as { headers?: Record<string, string> })?.headers ?? {})['Idempotency-Key'];
const FAILED = { error: 'Generation failed', billing: { charged: 0, released: 40, reason: 'failed' } };

beforeEach(() => {
  fetchWithAuth.mockReset();
  routerState.push = jest.fn();
  (global as { fetch?: unknown }).fetch = jest.fn();
  window.scrollTo = jest.fn() as never;
});

// ── the rule (pure) ─────────────────────────────────────────────────────────
describe('keepBlogKey: keep only while the outcome is unknown', () => {
  it.each([
    ['409 same key still running', 409, { code: 'BLOG_ALREADY_IN_PROGRESS' }, true],
    ['500 with no billing facts', 500, { error: 'boom' }, true],
    ['500 with billing facts (released 40)', 500, FAILED, false],
    ['503 switch unreadable (nothing held)', 503, { code: 'BLOG_SWITCH_UNAVAILABLE' }, false],
    ['503 billing down (nothing held)', 503, { code: 'BILLING_UNAVAILABLE' }, false],
    ['200 done', 200, { result: {} }, false],
    ['402 not enough credits', 402, { code: 'INSUFFICIENT_CREDITS', required: 40, available: 3 }, false],
    ['422 quality refund', 422, { billing: { charged: 0, released: 40, reason: 'quality_refund' } }, false],
    ['409 already settled', 409, { code: 'RESERVATION_ALREADY_SETTLED' }, false],
    ['403 switched off', 403, { code: 'BLOG_GENERATION_DISABLED' }, false],
  ])('%s', (_n, status, body, keep) => {
    expect(keepBlogKey(status as number, body)).toBe(keep);
  });
});

describe('blogRefusalText', () => {
  it('in progress -> b3’s plain line; key missing -> our fault, not the user’s; others -> server sentence', () => {
    expect(blogRefusalText({ code: 'BLOG_ALREADY_IN_PROGRESS', error: 'This blog is already being generated.' })).toBe(BLOG_IN_PROGRESS_TEXT);
    expect(BLOG_IN_PROGRESS_TEXT).toBe('This blog is already being written.');
    expect(blogRefusalText({ code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'An Idempotency-Key header...' })).not.toMatch(/Idempotency|header/);
    expect(blogRefusalText({ code: 'BLOG_GENERATION_DISABLED', error: 'Blog generation is turned off for this account.' })).toBe('Blog generation is turned off for this account.');
    expect(blogRefusalText({ code: 'BLOG_SWITCH_UNAVAILABLE', error: 'Blog generation is temporarily unavailable. Please try again.' })).toMatch(/temporarily unavailable/);
    expect(blogRefusalText({ code: 'RESERVATION_ALREADY_SETTLED' })).toMatch(/already finished/);
    expect(blogRefusalText({ code: 'INSUFFICIENT_CREDITS', error: 'x' })).toBeNull();
    expect(blogRefusalText({})).toBeNull();
  });
  it('scopes separate different requests', () => {
    expect(blogKeyScope('c1', 'A')).not.toBe(blogKeyScope('c1', 'B'));
    expect(blogKeyScope(null, '')).toBe('default');
  });
});

// ── caller 1: pages/blogs/suggestions.tsx ───────────────────────────────────
describe('pages/blogs/suggestions.tsx', () => {
  async function mountAndGenerate(topic: string, generateReplies: Array<unknown>) {
    routerState.query = { topic, words: '1200' };
    const genCalls: unknown[] = [];
    fetchWithAuth.mockImplementation(async (url: string, init: unknown) => {
      if (url === '/api/blogs/generate') {
        genCalls.push(init);
        const next = generateReplies.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return reply(200, { uniqueness_directive_options: ['u'], must_include_points_options: [], campaign_objective_options: [], trend_context_options: [] });
    });
    render(<BlogSuggestionsPage />);
    const button = await screen.findByRole('button', { name: /generate/i });
    return { button, genCalls };
  }

  it('sends an Idempotency-Key (≥ 8 chars) on Generate', async () => {
    const { button, genCalls } = await mountAndGenerate('S-header', [reply(200, { result: { title: 't' } })]);
    fireEvent.click(button);
    await waitFor(() => expect(genCalls).toHaveLength(1));
    expect(keyOf(genCalls[0])).toEqual(expect.any(String));
    expect((keyOf(genCalls[0]) as string).length).toBeGreaterThanOrEqual(8);
  });

  it('409 in progress -> plain line, and the next click REUSES the key', async () => {
    const { button, genCalls } = await mountAndGenerate('S-busy', [
      reply(409, { code: 'BLOG_ALREADY_IN_PROGRESS', error: 'This blog is already being generated.', retryable: true }),
      reply(200, { result: { title: 't' } }),
    ]);
    fireEvent.click(button);
    expect(await screen.findByText('This blog is already being written.')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));
    await waitFor(() => expect(genCalls).toHaveLength(2));
    expect(keyOf(genCalls[1])).toBe(keyOf(genCalls[0]));
  });

  it('connection lost -> the retry reuses the key; a known failure -> the next click gets a NEW key', async () => {
    const { button, genCalls } = await mountAndGenerate('S-lost', [
      new TypeError('Failed to fetch'),
      reply(500, FAILED),
      reply(200, { result: { title: 't' } }),
    ]);
    fireEvent.click(button);
    await waitFor(() => expect(genCalls).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));
    await waitFor(() => expect(genCalls).toHaveLength(2));
    expect(keyOf(genCalls[1])).toBe(keyOf(genCalls[0]));
    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));
    await waitFor(() => expect(genCalls).toHaveLength(3));
    expect(keyOf(genCalls[2])).not.toBe(keyOf(genCalls[1]));
  });
});

// ── caller 2: pages/admin/blog/content-refine.tsx ───────────────────────────
describe('pages/admin/blog/content-refine.tsx', () => {
  async function mount(topic: string, replies: Array<unknown>) {
    const token = `tok-${topic}`;
    sessionStorage.setItem(token, JSON.stringify({ selectedCompanyId: 'c1', prefillTopic: topic }));
    routerState.query = { prefill: token };
    const calls: unknown[] = [];
    (global as { fetch?: unknown }).fetch = jest.fn(async (url: string, init: unknown) => {
      if (url === '/api/admin/blog/generate') {
        calls.push(init);
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return reply(200, {});
    });
    render(<ContentRefinePage />);
    const button = await screen.findByRole('button', { name: /Generate Draft and Open Editor/ });
    await waitFor(() => expect(button).not.toBeDisabled());
    return { button, calls };
  }

  it('sends an Idempotency-Key; a known refusal ends it, a lost connection keeps it', async () => {
    const { button, calls } = await mount('R-1', [
      reply(402, { code: 'INSUFFICIENT_CREDITS', error: 'Not enough credits to generate this blog.', required: 40, available: 3 }),
      new TypeError('Failed to fetch'),
      reply(409, { code: 'BLOG_ALREADY_IN_PROGRESS', error: 'This blog is already being generated.' }),
    ]);
    fireEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((keyOf(calls[0]) ?? '').length).toBeGreaterThanOrEqual(8);
    await screen.findByText('Not enough credits to generate this blog.');
    fireEvent.click(screen.getByRole('button', { name: /Generate Draft and Open Editor/ }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(keyOf(calls[1])).not.toBe(keyOf(calls[0])); // 402 was final: new request
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate Draft and Open Editor/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate Draft and Open Editor/ }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(keyOf(calls[2])).toBe(keyOf(calls[1])); // lost connection: same request
    expect(await screen.findByText('This blog is already being written.')).toBeInTheDocument();
  });
});

// ── caller 3: components/blog/BlogGenerateModalMain.tsx ─────────────────────
describe('BlogGenerateModal (full draft)', () => {
  const ANGLES = { angles: [{ type: 'analytical', label: 'Analytical', title: 'Angle title', angle_summary: 's', hook: 'h' }] };

  async function toWriteStep(contentType: 'blog' | 'article', topic: string, fullReplies: Array<unknown>) {
    const endpoint = contentType === 'blog' ? '/api/blogs/generate' : '/api/articles/generate';
    const full: unknown[] = [];
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
    render(<BlogGenerateModal companyId="c1" initialTopic={topic} contentType={contentType} onClose={() => {}} onGenerated={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(await screen.findByText('Angle title'));
    const write = () => screen.getByRole('button', { name: /Write This/ });
    return { full, write };
  }

  it('a blog sends an Idempotency-Key; the angles call does not need one', async () => {
    const { full, write } = await toWriteStep('blog', 'M-header', [reply(200, { result: { title: 't' } })]);
    fireEvent.click(write());
    await waitFor(() => expect(full).toHaveLength(1));
    expect((keyOf(full[0]) ?? '').length).toBeGreaterThanOrEqual(8);
  });

  it('a non-blog type sends no key (its route is not billed by c6)', async () => {
    const { full, write } = await toWriteStep('article', 'M-article', [reply(200, { result: { title: 't' } })]);
    fireEvent.click(write());
    await waitFor(() => expect(full).toHaveLength(1));
    expect(keyOf(full[0])).toBeUndefined();
  });

  it('lost connection -> retry reuses the key; in-progress -> plain line; a known failure -> new key', async () => {
    const { full, write } = await toWriteStep('blog', 'M-lost', [
      new TypeError('Failed to fetch'),
      reply(409, { code: 'BLOG_ALREADY_IN_PROGRESS', error: 'This blog is already being generated.' }),
      reply(500, FAILED),
      reply(200, { result: { title: 't' } }),
    ]);
    fireEvent.click(write());
    await waitFor(() => expect(full).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /Write This/ }));
    await waitFor(() => expect(full).toHaveLength(2));
    expect(keyOf(full[1])).toBe(keyOf(full[0]));
    expect(await screen.findByText('This blog is already being written.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Write This/ }));
    await waitFor(() => expect(full).toHaveLength(3));
    expect(keyOf(full[2])).toBe(keyOf(full[1])); // still in progress: same request
    fireEvent.click(await screen.findByRole('button', { name: /Write This/ }));
    await waitFor(() => expect(full).toHaveLength(4));
    expect(keyOf(full[3])).not.toBe(keyOf(full[2])); // 500 with billing facts was final
  });
});

afterAll(() => {
  // the gate is module-level; nothing must leak between suites
  blogGenerateKeys.end();
});
