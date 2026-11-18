/**
 * @jest-environment jsdom
 *
 * Post Now failure copy (PromotionWorkspace). The server now cancels the staged
 * row's queued publish job before it publishes, and refuses to publish when it
 * cannot (publishNowSupersedesQueue.test.ts), so a failed Post Now posts
 * nothing later on its own. The copy says so: "Not posted: <reason>. Nothing
 * will be posted automatically. You can try again." — for a publish failure,
 * for the refusal when the job could not be cancelled, and for a staging
 * failure (no row exists then). An UNCERTAIN outcome (the post may be live)
 * is never called "not posted".
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockFetch = jest.fn();
jest.mock('../../../components/community-ai/fetchWithAuth', () => ({
  fetchWithAuth: (...a: unknown[]) => mockFetch(...a),
}));
jest.mock('../../../lib/content/promotionDraft', () => {
  const actual = jest.requireActual('../../../lib/content/promotionDraft');
  return {
    ...actual,
    loadPromotionDrafts: jest.fn(async () => []),
    savePromotionDraft: jest.fn(async () => undefined),
    deletePromotionDraft: jest.fn(async () => undefined),
  };
});

import PromotionWorkspace, { postNowFailureDetail } from '../../../components/content/PromotionWorkspace';

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function renderWorkspace() {
  render(
    <PromotionWorkspace
      open
      contentId="c-1"
      contentType={'blog' as never}
      title="T"
      topic="t"
      sourceContent="s"
      companyId="co-1"
      blogUrl="https://example.test/blog"
      seeds={[{ platform: 'linkedin', label: 'LinkedIn', accountId: 'acct-1', promotionalText: 'Read it' }]}
      onClose={() => undefined}
    />,
  );
}

const NOTHING = 'Nothing will be posted automatically. You can try again.';

beforeEach(() => mockFetch.mockReset());

describe('postNowFailureDetail', () => {
  test('with a reason', () => {
    expect(postNowFailureDetail(new Error('slow down'))).toBe(`Not posted: slow down. ${NOTHING}`);
  });
  test('a reason ending in a full stop is not doubled', () => {
    expect(postNowFailureDetail(new Error('The platform rejected the post.'))).toBe(`Not posted: The platform rejected the post. ${NOTHING}`);
  });
  test('without a reason', () => {
    expect(postNowFailureDetail('x')).toBe(`Not posted. ${NOTHING}`);
    expect(postNowFailureDetail(new Error(''))).toBe(`Not posted. ${NOTHING}`);
  });
  test('an uncertain outcome is shown as the server words it, never "not posted"', () => {
    const msg = 'Publish outcome unknown: the request may have reached the platform but no result was saved.';
    expect(postNowFailureDetail(new Error(msg))).toBe(msg);
    expect(postNowFailureDetail(Object.assign(new Error('may be live'), { outcomeUncertain: true }))).toBe('may be live');
  });
});

describe('PromotionWorkspace Post Now (DOM)', () => {
  test('publish FAILED: the component shows the not-posted copy', async () => {
    mockFetch
      .mockResolvedValueOnce(json(200, { id: 'sp-1' }))
      .mockResolvedValueOnce(json(200, { status: 'FAILED', message: 'slow down' }));
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /post now/i }));
    expect(await screen.findByText(`Not posted: slow down. ${NOTHING}`)).toBeInTheDocument();
    expect(mockFetch.mock.calls[1][0]).toBe('/api/social/publish');
  });

  test('the job-cancel refusal (503 PRIOR_JOB_CANCEL_FAILED): the not-posted copy', async () => {
    mockFetch
      .mockResolvedValueOnce(json(200, { id: 'sp-2' }))
      .mockResolvedValueOnce(json(503, {
        status: 'FAILED', code: 'PRIOR_JOB_CANCEL_FAILED', error: 'its queued publish job could not be cancelled',
      }));
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /post now/i }));
    expect(await screen.findByText(`Not posted: its queued publish job could not be cancelled. ${NOTHING}`)).toBeInTheDocument();
  });

  test('STAGING fails (no row exists): the same copy', async () => {
    mockFetch.mockResolvedValueOnce(json(400, { error: 'Scheduled time must be in the future' }));
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /post now/i }));
    expect(await screen.findByText(`Not posted: Scheduled time must be in the future. ${NOTHING}`)).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('an uncertain refusal (409 PUBLISH_OUTCOME_UNCERTAIN) is NOT reported as not posted', async () => {
    mockFetch
      .mockResolvedValueOnce(json(200, { id: 'sp-3' }))
      .mockResolvedValueOnce(json(409, { status: 'FAILED', code: 'PUBLISH_OUTCOME_UNCERTAIN', message: 'It may already be live.' }));
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /post now/i }));
    expect(await screen.findByText('It may already be live.')).toBeInTheDocument();
    expect(screen.queryByText(/Not posted/)).toBeNull();
  });

  test('control: a PUBLISHED result shows Posted.', async () => {
    mockFetch
      .mockResolvedValueOnce(json(200, { id: 'sp-4' }))
      .mockResolvedValueOnce(json(200, { status: 'PUBLISHED' }));
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /post now/i }));
    await waitFor(() => expect(screen.getByText('Posted.')).toBeInTheDocument());
  });
});
