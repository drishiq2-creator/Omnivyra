/**
 * idempotencyReference (7c, 2026-11-20): every idempotency kind yields its own caller-side reference, the join key
 * the billed_ai_settlement_unpriced record carries. Total over the union; an unknown kind throws, never returns ''.
 */
import { idempotencyReference } from '../../services/billing/billingIdempotencyService';

describe('idempotencyReference', () => {
  it.each<[string, any, string]>([
    ['http', { kind: 'http', actorUserId: 'u', action: 'a', referenceId: 'ref-1' }, 'ref-1'],
    ['queue', { kind: 'queue', queueName: 'q', jobId: 'job-9', organizationId: 'o', action: 'a', payloadFingerprint: 'f' }, 'job-9'],
    ['webhook', { kind: 'webhook', provider: 'razorpay', providerEventId: 'evt_1' }, 'evt_1'],
    ['cron', { kind: 'cron', cronName: 'nightly', action: 'a', bucketSeconds: 86400 }, 'nightly:86400'],
  ])('%s → its own reference (never null, never empty)', (_k, args, expected) => {
    expect(idempotencyReference(args)).toBe(expected);
  });

  it('an unknown kind THROWS (no silent empty join key)', () => {
    expect(() => idempotencyReference({ kind: 'carrier_pigeon' } as any)).toThrow(/unhandled kind/);
  });
});
