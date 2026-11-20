/**
 * The shared key-lifetime rule (b3: one helper, not a copy per caller).
 * Keep the key on an UNKNOWN outcome ONLY where the route replays (7c); end it otherwise.
 */
import { createBilledKeyLifetime, isUnknownOutcome, keepKey } from '../../../lib/billing/billedKeyLifetime';

describe('isUnknownOutcome', () => {
  it.each([
    ['5xx with no facts', 500, { error: 'boom' }, true],
    ['5xx stating its billing', 500, { billing: { charged: 0, released: 40, reason: 'failed' } }, false],
    ['5xx nothing started (billing down)', 503, { code: 'BILLING_UNAVAILABLE' }, false],
    ['400 key missing', 400, { code: 'IDEMPOTENCY_KEY_REQUIRED' }, false],
    ['409 in progress (middleware)', 409, { code: 'IDEMPOTENCY_IN_PROGRESS' }, true],
    ['409 conflict', 409, { code: 'IDEMPOTENCY_CONFLICT' }, false],
    ['503 replay unavailable', 503, { code: 'REPLAY_UNAVAILABLE' }, true],
    ['200', 200, { result: {} }, false],
    ['402', 402, { code: 'INSUFFICIENT_CREDITS' }, false],
    ['409 REQUEST_IN_PROGRESS (c6 activity-workspace)', 409, { code: 'REQUEST_IN_PROGRESS' }, true],
    ['409 REQUEST_ENDED (released, not charged)', 409, { code: 'REQUEST_ENDED' }, false],
    ['409 RESULT_UNAVAILABLE (terminal, refunded)', 409, { code: 'RESULT_UNAVAILABLE' }, false],
    ['apiFetch synthetic 503 (lost connection)', 503, { error: 'Network unreachable' }, true],
  ])('%s', (_n, status, body, unknown) => {
    expect(isUnknownOutcome(status as number, body)).toBe(unknown);
  });
});

describe('keepKey: only where the route replays', () => {
  it('replaying route: keep on lost / unknown; end on known', () => {
    expect(keepKey({ lost: true }, { replays: true })).toBe(true);
    expect(keepKey({ status: 500, body: {} }, { replays: true })).toBe(true);
    expect(keepKey({ status: 200, body: {} }, { replays: true })).toBe(false);
  });
  it('NON-replaying route: end on everything (a kept key would trap the user)', () => {
    expect(keepKey({ lost: true }, { replays: false })).toBe(false);
    expect(keepKey({ status: 500, body: {} }, { replays: false })).toBe(false);
    expect(keepKey({ status: 409, body: { code: 'IDEMPOTENCY_IN_PROGRESS' } }, { replays: false })).toBe(false);
  });
});

describe('createBilledKeyLifetime', () => {
  it('replaying: a lost action keeps its key for the retry; a known one mints a new key next', () => {
    const g = createBilledKeyLifetime('t-replay', { replays: true });
    const a = g.begin('s').key;
    expect(g.begin('s').key).toBe(a); // in flight: same key
    expect(g.finish('s', { lost: true })).toBe(true);
    expect(g.begin('s').key).toBe(a); // retry after lost: same key
    expect(g.finish('s', { status: 200, body: {} })).toBe(false);
    expect(g.begin('s').key).not.toBe(a); // next action: new key
  });
  it('non-replaying: a lost action still ends the key', () => {
    const g = createBilledKeyLifetime('t-noreplay', { replays: false });
    const a = g.begin('s').key;
    g.finish('s', { lost: true });
    expect(g.begin('s').key).not.toBe(a);
  });
  it('scopes are independent', () => {
    const g = createBilledKeyLifetime('t-scope', { replays: true });
    expect(g.begin('x').key).not.toBe(g.begin('y').key);
  });
});

// One invariant across the two modules (c6 2026-11-19: *_UNVERIFIABLE is not a billing vocabulary; ROLE_
// is raised AFTER the effect): where the copy says "check before trying again", the key is KEPT, so a
// retry is the same request. Lives here because only this branch has both modules.
describe('unlisted *_UNVERIFIABLE: copy and key lifetime agree', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { classifyBilledResponse } = require('../../../lib/billing/billedResponse');
  it.each(['ROLE_UNVERIFIABLE', 'SOME_FUTURE_UNVERIFIABLE'])('%s: uncertain copy AND the key is kept', (code) => {
    const body = { error: 'x', code };
    expect(classifyBilledResponse(503, body, 'fallback').kind).toBe('uncertain');
    expect(isUnknownOutcome(503, body)).toBe(true);
  });
});
