/**
 * salesNavRouteGate + the LinkedIn-restriction acknowledgement (b3 ruling 1). Every condition closes the gate on its
 * own, every lookup failure fails CLOSED, and the all-open case is the control that proves the refusals are about
 * the condition under test.
 */
import { salesNavRouteGate, salesNavLegalSwitch, SALESNAV_EXTRACTION_FLAG, salesNavTransportFlag } from '../../services/salesNav/gate';
import {
  ackCoversCurrentText, readLatestSalesNavAck, recordSalesNavAck, SALESNAV_RESTRICTION_ACK, SalesNavAckRefused,
} from '../../services/salesNav/restrictionAck';

const ctx = { organizationId: 'org-1', initiatedBy: 'user-1' };
const CURRENT = { consent_version: SALESNAV_RESTRICTION_ACK.version, granted_by: 'user-1', granted_at: '2026-11-21T00:00:00Z' };
const flagsOn = async () => ({ enabled: true, reason: 'on' }) as never;
const open = {
  env: { [salesNavLegalSwitch('unipile')]: 'true' },
  evaluate: flagsOn,
  readAck: async () => CURRENT,
};

describe('salesNavRouteGate', () => {
  it('CONTROL: everything open -> allowed', async () => {
    expect(await salesNavRouteGate(ctx, 'unipile', open)).toEqual({ allowed: true, reason: 'cleared' });
  });

  it.each([undefined, 'TRUE', '1', 'yes', ' true'])('legal switch %p is OFF (strict === "true")', async (v) => {
    const d = await salesNavRouteGate(ctx, 'unipile', { ...open, env: { [salesNavLegalSwitch('unipile')]: v } });
    expect(d).toEqual({ allowed: false, reason: 'legal_not_cleared' });
  });

  it('clearing ONE transport does not clear another', async () => {
    expect((await salesNavRouteGate(ctx, 'rpa', open)).reason).toBe('legal_not_cleared');
  });

  it.each([SALESNAV_EXTRACTION_FLAG, salesNavTransportFlag('unipile')])('company flag %s off -> closed', async (off) => {
    const evaluate = async (a: { flagKey: string }) => ({ enabled: a.flagKey !== off, reason: 'x' }) as never;
    expect(await salesNavRouteGate(ctx, 'unipile', { ...open, evaluate: evaluate as never }))
      .toEqual({ allowed: false, reason: `tenant_flag_off:${off}` });
  });

  it('a flag lookup that throws fails CLOSED', async () => {
    const evaluate = async () => { throw new Error('db down'); };
    expect((await salesNavRouteGate(ctx, 'unipile', { ...open, evaluate: evaluate as never })).reason)
      .toBe(`flag_unreadable:${SALESNAV_EXTRACTION_FLAG}`);
  });

  it('no acknowledgement -> closed (ack_missing)', async () => {
    expect((await salesNavRouteGate(ctx, 'unipile', { ...open, readAck: async () => null })).reason).toBe('ack_missing');
  });

  it('an acknowledgement of an OLDER text -> closed (re-ack required)', async () => {
    const old = { ...CURRENT, consent_version: 'placeholder-v-old' };
    expect((await salesNavRouteGate(ctx, 'unipile', { ...open, readAck: async () => old })).reason).toBe('ack_text_changed');
  });

  it('an UNREADABLE ledger fails CLOSED - never "no ack needed"', async () => {
    expect((await salesNavRouteGate(ctx, 'unipile', { ...open, readAck: async () => 'unreadable' as const })).reason).toBe('ack_unreadable');
  });
});

describe('the acknowledgement store', () => {
  const builder = (result: unknown) => {
    const calls: Array<[string, unknown[]]> = [];
    const b: any = new Proxy({}, {
      get: (_t, prop) => (prop === 'then'
        ? (res: (v: unknown) => void) => res(result)
        : (...args: unknown[]) => { calls.push([String(prop), args]); return b; }),
    });
    return { table: () => b, calls };
  };

  it('reads the latest UNREVOKED ack for (company, transport) by platform + capability', async () => {
    const { table, calls } = builder({ data: [CURRENT], error: null, status: 200 });
    expect(await readLatestSalesNavAck('org-1', 'unipile', { table })).toEqual(CURRENT);
    expect(calls).toEqual(expect.arrayContaining([
      ['eq', ['organization_id', 'org-1']], ['eq', ['platform', 'salesnav:unipile']],
      ['eq', ['capability', 'salesnav_linkedin_restriction_ack']], ['is', ['revoked_at', null]],
      ['order', ['granted_at', { ascending: false }]],
    ]));
  });

  it('no rows -> null (control for the unreadable cases)', async () => {
    expect(await readLatestSalesNavAck('org-1', 'unipile', builder({ data: [], error: null, status: 200 }))).toBeNull();
  });

  it.each([
    ['an error', { data: null, error: { message: 'x' }, status: 500 }],
    ['a blank 204 with a null error (not an answer)', { data: null, error: null, status: 204 }],
    ['a non-array', { data: {}, error: null, status: 200 }],
  ])('%s -> unreadable', async (_l, result) => {
    expect(await readLatestSalesNavAck('org-1', 'unipile', builder(result))).toBe('unreadable');
  });

  it('ackCoversCurrentText: only the current version', () => {
    expect(ackCoversCurrentText(CURRENT)).toBe(true);
    expect(ackCoversCurrentText({ ...CURRENT, consent_version: 'x' })).toBe(false);
    expect(ackCoversCurrentText(null)).toBe(false);
  });

  it('records the shown text with version, hash, placeholder status, user, company, transport platform', async () => {
    const record = jest.fn(async () => ({}) as never);
    await recordSalesNavAck(ctx, {
      transport: 'unipile', shownVersion: SALESNAV_RESTRICTION_ACK.version, shownTextSha256: SALESNAV_RESTRICTION_ACK.textSha256,
    }, { record, now: () => new Date('2026-11-21T10:00:00Z') });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', platform: 'salesnav:unipile', capability: 'salesnav_linkedin_restriction_ack',
      grantedBy: 'user-1', grantedAt: '2026-11-21T10:00:00.000Z', consentVersion: SALESNAV_RESTRICTION_ACK.version,
      metadata: { text_sha256: SALESNAV_RESTRICTION_ACK.textSha256, wording_status: 'placeholder' },
    }));
  });

  it.each([
    ['an old version', { shownVersion: 'old', shownTextSha256: SALESNAV_RESTRICTION_ACK.textSha256 }],
    ['a different text hash', { shownVersion: SALESNAV_RESTRICTION_ACK.version, shownTextSha256: 'f'.repeat(64) }],
  ])('refuses to record %s (stale_text) and writes nothing', async (_l, shown) => {
    const record = jest.fn();
    await expect(recordSalesNavAck(ctx, { transport: 'unipile', ...shown }, { record: record as never }))
      .rejects.toEqual(new SalesNavAckRefused('stale_text'));
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses without a user (a system continuation cannot acknowledge)', async () => {
    await expect(recordSalesNavAck({ organizationId: 'org-1', initiatedBy: null }, {
      transport: 'unipile', shownVersion: SALESNAV_RESTRICTION_ACK.version, shownTextSha256: SALESNAV_RESTRICTION_ACK.textSha256,
    })).rejects.toEqual(new SalesNavAckRefused('no_user'));
  });

  it('a failed write is write_failed, never success', async () => {
    const record = async () => { throw new Error('insert failed'); };
    await expect(recordSalesNavAck(ctx, {
      transport: 'unipile', shownVersion: SALESNAV_RESTRICTION_ACK.version, shownTextSha256: SALESNAV_RESTRICTION_ACK.textSha256,
    }, { record: record as never })).rejects.toEqual(new SalesNavAckRefused('write_failed'));
  });
});
