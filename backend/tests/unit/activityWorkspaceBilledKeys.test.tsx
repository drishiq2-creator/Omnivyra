/**
 * @jest-environment jsdom
 *
 * b3, 2026-11-18, BLOCKING-launch (money): activity-workspace generate_variants and refine_variant
 * were charged with Date.now() fallback keys, so every retry was a second charge. Contract (c6):
 * both REQUIRE the client's Idempotency-Key and REPLAY for the same key (same server release).
 * The client sends one key per action, scoped to the target AND its content, kept on an unknown
 * outcome (a lost connection arrives from apiFetch as a synthetic 503; a caller timeout as an abort)
 * and ended on a known one. All copy comes from the canonical billed mapping.
 */
import { renderHook, act } from '@testing-library/react';

const apiFetch = jest.fn();
jest.mock('../../../lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@/lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@/components/RichTextEditor', () => ({ htmlToPlainText: (s: string) => s }));

import { postGenerateVariants, UnconfirmedOutcomeError } from '../../../lib/activity-workspace/postGenerateVariants';
import { useActivityWorkspaceRefinementOps } from '../../../hooks/useActivityWorkspaceRefinementOps';
import { UNCERTAIN_MESSAGE } from '../../../lib/billing/billedResponse';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const keyOf = (call: unknown[]): string | undefined => ((call[1] as { headers?: Record<string, string> })?.headers ?? {})['Idempotency-Key'];
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

beforeEach(() => apiFetch.mockReset());

describe('postGenerateVariants (the ONE keyed generate_variants request; hook, pipeline and scheduler use it)', () => {
  it('sends an Idempotency-Key (≥ 8 chars) and action generate_variants', async () => {
    apiFetch.mockResolvedValueOnce(reply(200, { platform_variants: [] }));
    await postGenerateVariants('t1|A', { activity: { id: 'a1' } }, 'fail');
    expect((keyOf(apiFetch.mock.calls[0]) ?? '').length).toBeGreaterThanOrEqual(8);
    expect(JSON.parse((apiFetch.mock.calls[0][1] as { body: string }).body).action).toBe('generate_variants');
  });

  it('lost connection (apiFetch synthetic 503) -> UnconfirmedOutcomeError with the uncertain text; the retry REUSES the key', async () => {
    apiFetch.mockResolvedValueOnce(reply(503, { error: 'Network unreachable', detail: 'Failed to fetch' }));
    apiFetch.mockResolvedValueOnce(reply(200, { platform_variants: [], replayed: true }));
    await expect(postGenerateVariants('t2|A', {}, 'fail')).rejects.toEqual(new UnconfirmedOutcomeError(UNCERTAIN_MESSAGE));
    await postGenerateVariants('t2|A', {}, 'fail');
    expect(keyOf(apiFetch.mock.calls[1])).toBe(keyOf(apiFetch.mock.calls[0]));
  });

  it('a caller timeout (abort) keeps the key too', async () => {
    apiFetch.mockRejectedValueOnce(abortError());
    apiFetch.mockResolvedValueOnce(reply(200, {}));
    await expect(postGenerateVariants('t3|A', {}, 'fail')).rejects.toBeInstanceOf(UnconfirmedOutcomeError);
    await postGenerateVariants('t3|A', {}, 'fail');
    expect(keyOf(apiFetch.mock.calls[1])).toBe(keyOf(apiFetch.mock.calls[0]));
  });

  it('409 REQUEST_IN_PROGRESS keeps the key; REQUEST_ENDED ends it (known, not charged)', async () => {
    apiFetch.mockResolvedValueOnce(reply(409, { code: 'REQUEST_IN_PROGRESS', retryable: true, error: 'Still running.' }));
    apiFetch.mockResolvedValueOnce(reply(409, { code: 'REQUEST_ENDED', retryable: false, error: 'This did not finish and you were not charged.' }));
    apiFetch.mockResolvedValueOnce(reply(200, {}));
    await expect(postGenerateVariants('t4|A', {}, 'fail')).rejects.toBeInstanceOf(UnconfirmedOutcomeError);
    await expect(postGenerateVariants('t4|A', {}, 'fail')).rejects.toThrow('This did not finish and you were not charged.');
    await postGenerateVariants('t4|A', {}, 'fail');
    const [k1, k2, k3] = apiFetch.mock.calls.map(keyOf);
    expect(k2).toBe(k1);
    expect(k3).not.toBe(k2);
  });

  it('402 -> the canonical credits text (not an unconfirmed outcome); the key ends', async () => {
    apiFetch.mockResolvedValueOnce(reply(402, { code: 'INSUFFICIENT_CREDITS', error: 'Not enough credits', required: 10, available: 2 }));
    apiFetch.mockResolvedValueOnce(reply(200, {}));
    const err = await postGenerateVariants('t5|A', {}, 'fail').catch((e) => e);
    expect(err).not.toBeInstanceOf(UnconfirmedOutcomeError);
    expect(String(err.message)).toMatch(/Top up credits on the Billing page/);
    await postGenerateVariants('t5|A', {}, 'fail');
    expect(keyOf(apiFetch.mock.calls[1])).not.toBe(keyOf(apiFetch.mock.calls[0]));
  });

  it('a kept key never carries over to EDITED content (scope includes the content)', async () => {
    apiFetch.mockResolvedValueOnce(reply(503, { error: 'Network unreachable' }));
    apiFetch.mockResolvedValueOnce(reply(200, {}));
    await expect(postGenerateVariants('t6|old text', {}, 'fail')).rejects.toBeInstanceOf(UnconfirmedOutcomeError);
    await postGenerateVariants('t6|edited text', {}, 'fail');
    expect(keyOf(apiFetch.mock.calls[1])).not.toBe(keyOf(apiFetch.mock.calls[0]));
  });
});

describe('refine_variant (rendered through useActivityWorkspaceRefinementOps)', () => {
  function setup(input = 'shorter please', content = 'Original text') {
    const notify = jest.fn();
    const schedule = { id: 's1', platform: 'linkedin', contentType: 'post' } as never;
    const params = {
      payload: { companyId: 'c1', campaignId: 'k1', dailyExecutionItem: {} },
      schedules: [schedule], platformVariants: [{ platform: 'linkedin', content_type: 'post', generated_content: content }],
      workspaceKey: 'w', queryCampaignId: 'k1', selectedCompanyId: 'c1', connectedPlatforms: [], router: { push: jest.fn() },
      normalizeKey: (v: unknown) => String(v ?? '').toLowerCase(), labelize: (v: string) => v, notify,
      findVariantForSchedule: () => ({ platform: 'linkedin', content_type: 'post', generated_content: content }),
      updateSchedule: jest.fn(), setPayload: jest.fn(), setConnectedPlatforms: jest.fn(), setIsRefiningByScheduleId: jest.fn(),
      setRefineMessagesByScheduleId: jest.fn(), setRefineInputByScheduleId: jest.fn(), setFinalizedByScheduleId: jest.fn(),
      setSchedulingByScheduleId: jest.fn(), refineInputByScheduleId: { s1: input },
    };
    const { result } = renderHook(() => useActivityWorkspaceRefinementOps(params as never));
    return { result, schedule, notify };
  }

  it('lost connection -> the retry REUSES the key; success -> the next refine is a NEW key', async () => {
    apiFetch.mockResolvedValueOnce(reply(503, { error: 'Network unreachable' }));
    apiFetch.mockResolvedValueOnce(reply(200, { refined_content: 'Short.', replayed: true }));
    apiFetch.mockResolvedValueOnce(reply(200, { refined_content: 'Shorter.' }));
    const { result, schedule, notify } = setup();
    await act(async () => { await result.current.handleRefineWithAi(schedule); });
    expect(notify).toHaveBeenCalledWith('info', UNCERTAIN_MESSAGE);
    await act(async () => { await result.current.handleRefineWithAi(schedule); });
    await act(async () => { await result.current.handleRefineWithAi(schedule); });
    const [k1, k2, k3] = apiFetch.mock.calls.map(keyOf);
    expect((k1 ?? '').length).toBeGreaterThanOrEqual(8);
    expect(k2).toBe(k1);
    expect(k3).not.toBe(k2);
  });

  it('an abort keeps the key (finally path)', async () => {
    apiFetch.mockRejectedValueOnce(abortError());
    apiFetch.mockResolvedValueOnce(reply(200, { refined_content: 'x' }));
    const { result, schedule } = setup('abort case');
    await act(async () => { await result.current.handleRefineWithAi(schedule); });
    await act(async () => { await result.current.handleRefineWithAi(schedule); });
    expect(keyOf(apiFetch.mock.calls[1])).toBe(keyOf(apiFetch.mock.calls[0]));
  });
});
