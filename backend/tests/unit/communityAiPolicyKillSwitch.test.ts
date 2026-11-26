/**
 * 24B: community-AI kill switch (evaluateCommunityAiExecutionPolicy).
 *
 *   missing row  -> automated execution OFF (auto, scheduler, rpa_retry),
 *                   extension hand-out needs approved_at, manual/bulk human
 *                   clicks still allowed;
 *   unreadable   -> everything refused;
 *   configured   -> honoured as configured.
 *
 * Every scenario pairs its assertion with a control: either the OLD
 * behaviour (what callers decide today from the legacy getter, which a
 * missing row lets through) or the same request with the deciding input
 * flipped, so an assertion that passes for the wrong reason goes red.
 */

type PolicyRead = () => Promise<{ data: unknown; error: unknown }>;

let policyRead: PolicyRead = async () => ({ data: [], error: null });
let reads = 0;

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      if (table !== 'community_ai_platform_policy') throw new Error(`unexpected table in test: ${table}`);
      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => {
          reads += 1;
          return policyRead();
        },
      };
      return chain;
    }),
  },
}));

import {
  __resetCommunityAiPlatformPolicyCacheForTests,
  decideCommunityAiAutomatedTick,
  decideCommunityAiExecutionPolicy,
  evaluateCommunityAiExecutionPolicy,
  getCommunityAiPlatformPolicy,
  resolveCommunityAiPlatformPolicy,
  type CommunityAiExecutionInitiator,
  type CommunityAiPlatformPolicy,
} from '../../services/communityAiPlatformPolicyService';

const APPROVED_AT = '2026-11-20T10:00:00.000Z';

const row = (over: Partial<CommunityAiPlatformPolicy> = {}) => ({
  execution_enabled: true,
  auto_rules_enabled: true,
  require_human_approval: false,
  updated_at: '2026-11-01T00:00:00.000Z',
  updated_by: 'owner',
  ...over,
});

/**
 * OLD behaviour: what the automated callers decide today from the legacy
 * getter. Scheduler / RPA retry / extension hand-out check execution_enabled
 * (and approved_at where approval is required or of record); auto checks
 * auto_rules_enabled.
 */
const legacyCallerAllows = (
  policy: CommunityAiPlatformPolicy,
  initiator: CommunityAiExecutionInitiator,
  approvedAt: string | null
): boolean => {
  if (!policy.execution_enabled) return false;
  if (initiator === 'auto' && !policy.auto_rules_enabled) return false;
  if ((initiator === 'scheduler' || initiator === 'rpa_retry') && !approvedAt) return false;
  if (policy.require_human_approval && !approvedAt) return false;
  return true;
};

describe('community AI kill switch (24B)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    __resetCommunityAiPlatformPolicyCacheForTests();
    reads = 0;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  describe('missing row (production today: 0 rows)', () => {
    beforeEach(() => {
      policyRead = async () => ({ data: [], error: null });
    });

    it('the scenario exists: the read succeeds with no row', async () => {
      const resolution = await resolveCommunityAiPlatformPolicy();
      expect(resolution.state).toBe('missing_row');
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(['scheduler', 'rpa_retry', 'auto'] as const)(
      '%s is refused with policy_missing_fail_closed even with approved_at',
      async (initiator) => {
        const decision = await evaluateCommunityAiExecutionPolicy({ initiator, approved_at: APPROVED_AT });
        expect(decision).toEqual({
          allowed: false,
          reason_code: 'policy_missing_fail_closed',
          policy_flag: 'policy_missing',
          policy_state: 'missing_row',
          initiator,
        });
      }
    );

    it('CONTROL (old behaviour): the legacy getter lets an approved scheduler / RPA retry run', async () => {
      const legacy = await getCommunityAiPlatformPolicy();
      // Legacy getter is unchanged: execution on, approval not required.
      expect(legacy).toMatchObject({ execution_enabled: true, auto_rules_enabled: false, require_human_approval: false });
      expect(legacyCallerAllows(legacy, 'scheduler', APPROVED_AT)).toBe(true);
      expect(legacyCallerAllows(legacy, 'rpa_retry', APPROVED_AT)).toBe(true);
      // ...and an un-approved row is handed to the extension today.
      expect(legacyCallerAllows(legacy, 'extension_handout', null)).toBe(true);
    });

    it('extension hand-out: un-approved row refused, approved row (human send) allowed', async () => {
      const refused = await evaluateCommunityAiExecutionPolicy({ initiator: 'extension_handout', approved_at: null });
      expect(refused).toMatchObject({ allowed: false, reason_code: 'policy_missing_fail_closed' });
      // Control: the same hand-out with an approval of record goes out.
      const allowed = await evaluateCommunityAiExecutionPolicy({
        initiator: 'extension_handout',
        approved_at: APPROVED_AT,
      });
      expect(allowed).toMatchObject({ allowed: true, reason_code: null, policy_state: 'missing_row' });
    });

    it.each(['manual', 'bulk'] as const)(
      '%s (human click) stays allowed without approved_at — documented manual default',
      async (initiator) => {
        const decision = await evaluateCommunityAiExecutionPolicy({ initiator, approved_at: null });
        expect(decision).toEqual({ allowed: true, reason_code: null, policy_state: 'missing_row', initiator });
      }
    );

    it('the missing-row state is cached like the legacy getter (one read per TTL)', async () => {
      await evaluateCommunityAiExecutionPolicy({ initiator: 'scheduler' });
      await getCommunityAiPlatformPolicy();
      expect(reads).toBe(1);
    });
  });

  describe('unreadable policy', () => {
    it.each([
      ['query error', async () => ({ data: null, error: { code: '42501', message: 'denied' } })],
      ['query threw', async () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); }],
    ] as const)('%s: every initiator refused with policy_unreadable_fail_closed', async (_label, read) => {
      policyRead = read as PolicyRead;
      expect((await resolveCommunityAiPlatformPolicy()).state).toBe('unreadable');
      for (const initiator of ['manual', 'bulk', 'auto', 'scheduler', 'rpa_retry', 'extension_handout'] as const) {
        __resetCommunityAiPlatformPolicyCacheForTests();
        const decision = await evaluateCommunityAiExecutionPolicy({ initiator, approved_at: APPROVED_AT });
        expect(decision).toMatchObject({
          allowed: false,
          reason_code: 'policy_unreadable_fail_closed',
          policy_state: 'unreadable',
        });
      }
    });

    it('is not cached: the next call retries and recovers', async () => {
      policyRead = async () => ({ data: null, error: { code: '57014' } });
      expect((await evaluateCommunityAiExecutionPolicy({ initiator: 'manual' })).allowed).toBe(false);
      policyRead = async () => ({ data: [row()], error: null });
      expect((await evaluateCommunityAiExecutionPolicy({ initiator: 'manual' })).allowed).toBe(true);
      expect(reads).toBe(2);
    });

    it('CONTROL: the same manual click with a successful empty read is allowed (refusal is the read failure)', async () => {
      policyRead = async () => ({ data: [], error: null });
      expect(await evaluateCommunityAiExecutionPolicy({ initiator: 'manual' })).toMatchObject({ allowed: true });
    });
  });

  describe('configured row: enabled', () => {
    beforeEach(() => {
      policyRead = async () => ({ data: [row()], error: null });
    });

    it('the scenario exists: state is configured', async () => {
      expect((await resolveCommunityAiPlatformPolicy()).state).toBe('configured');
    });

    it.each(['manual', 'bulk', 'auto', 'scheduler', 'rpa_retry', 'extension_handout'] as const)(
      '%s with approved_at is allowed',
      async (initiator) => {
        expect(await evaluateCommunityAiExecutionPolicy({ initiator, approved_at: APPROVED_AT })).toEqual({
          allowed: true,
          reason_code: null,
          policy_state: 'configured',
          initiator,
        });
      }
    );

    it('scheduler / rpa_retry without approved_at still need an approval of record', async () => {
      for (const initiator of ['scheduler', 'rpa_retry'] as const) {
        expect(await evaluateCommunityAiExecutionPolicy({ initiator, approved_at: null })).toMatchObject({
          allowed: false,
          reason_code: 'approval_required',
          policy_flag: 'approval_of_record',
        });
      }
    });

    it('CONTROL (old behaviour agrees): an explicit enabled row is honoured exactly as before', async () => {
      const legacy = await getCommunityAiPlatformPolicy();
      for (const initiator of ['auto', 'scheduler', 'rpa_retry', 'extension_handout'] as const) {
        expect(legacyCallerAllows(legacy, initiator, APPROVED_AT)).toBe(true);
      }
    });

    it('auto with auto_rules_enabled=false is refused auto_rules_disabled; control: manual allowed', async () => {
      policyRead = async () => ({ data: [row({ auto_rules_enabled: false })], error: null });
      expect(await evaluateCommunityAiExecutionPolicy({ initiator: 'auto', approved_at: APPROVED_AT })).toMatchObject({
        allowed: false,
        reason_code: 'auto_rules_disabled',
        policy_flag: 'auto_rules_enabled',
      });
      expect((await evaluateCommunityAiExecutionPolicy({ initiator: 'manual' })).allowed).toBe(true);
    });
  });

  describe('configured row: execution disabled', () => {
    beforeEach(() => {
      policyRead = async () => ({ data: [row({ execution_enabled: false })], error: null });
    });

    it.each(['manual', 'bulk', 'auto', 'scheduler', 'rpa_retry', 'extension_handout'] as const)(
      '%s is refused execution_disabled even when approved',
      async (initiator) => {
        expect(await evaluateCommunityAiExecutionPolicy({ initiator, approved_at: APPROVED_AT })).toEqual({
          allowed: false,
          reason_code: 'execution_disabled',
          policy_flag: 'execution_enabled',
          policy_state: 'configured',
          initiator,
        });
      }
    );

    it('CONTROL: the same approved manual action under an enabled row is allowed', () => {
      const decision = decideCommunityAiExecutionPolicy(
        { state: 'configured', policy: { ...row(), execution_enabled: true } },
        { initiator: 'manual', approved_at: APPROVED_AT }
      );
      expect(decision.allowed).toBe(true);
    });
  });

  describe('configured row: human approval required', () => {
    beforeEach(() => {
      policyRead = async () => ({ data: [row({ require_human_approval: true })], error: null });
    });

    it('a manual click on an un-approved action is refused approval_required', async () => {
      expect(await evaluateCommunityAiExecutionPolicy({ initiator: 'manual', approved_at: null })).toEqual({
        allowed: false,
        reason_code: 'approval_required',
        policy_flag: 'require_human_approval',
        policy_state: 'configured',
        initiator: 'manual',
      });
    });

    it('an explicitly approved manual action (approved_at set) is allowed', async () => {
      expect(await evaluateCommunityAiExecutionPolicy({ initiator: 'manual', approved_at: APPROVED_AT })).toEqual({
        allowed: true,
        reason_code: null,
        policy_state: 'configured',
        initiator: 'manual',
      });
    });

    it('a blank approved_at is not an approval', async () => {
      expect((await evaluateCommunityAiExecutionPolicy({ initiator: 'manual', approved_at: '  ' })).allowed).toBe(false);
    });

    it('CONTROL: with require_human_approval=false the same un-approved manual click is allowed', () => {
      const decision = decideCommunityAiExecutionPolicy(
        { state: 'configured', policy: { ...row(), require_human_approval: false } },
        { initiator: 'manual', approved_at: null }
      );
      expect(decision.allowed).toBe(true);
    });
  });

  describe('explicitly approved manual action with NO row', () => {
    it('is allowed (human click on an approved action is preserved)', async () => {
      policyRead = async () => ({ data: [], error: null });
      expect(await evaluateCommunityAiExecutionPolicy({ initiator: 'manual', approved_at: APPROVED_AT })).toEqual({
        allowed: true,
        reason_code: null,
        policy_state: 'missing_row',
        initiator: 'manual',
      });
    });

    it('CONTROL: the same approved action dispatched by the scheduler is refused', async () => {
      policyRead = async () => ({ data: [], error: null });
      expect(
        (await evaluateCommunityAiExecutionPolicy({ initiator: 'scheduler', approved_at: APPROVED_AT })).reason_code
      ).toBe('policy_missing_fail_closed');
    });
  });

  describe('tick-level gate (decideCommunityAiAutomatedTick)', () => {
    const configured = (over: Partial<CommunityAiPlatformPolicy> = {}) =>
      ({ state: 'configured' as const, policy: { ...row(), ...over } });

    it.each(['auto', 'scheduler', 'rpa_retry'] as const)('%s tick: missing row refused, explicit row allowed', (initiator) => {
      const missing = decideCommunityAiAutomatedTick(
        { state: 'missing_row', policy: { ...row(), auto_rules_enabled: false, require_human_approval: false } },
        initiator
      );
      expect(missing).toMatchObject({ allowed: false, reason_code: 'policy_missing_fail_closed' });
      // CONTROL: an explicit enabled row lets the same tick run.
      expect(decideCommunityAiAutomatedTick(configured(), initiator)).toMatchObject({ allowed: true });
    });

    it('CONTROL (old behaviour): the tick callers check execution_enabled, which the missing row leaves true', async () => {
      policyRead = async () => ({ data: [], error: null });
      expect((await getCommunityAiPlatformPolicy()).execution_enabled).toBe(true);
    });

    it('unreadable / disabled / auto-rules-off ticks carry their reason codes', () => {
      expect(
        decideCommunityAiAutomatedTick({ state: 'unreadable', policy: row({ execution_enabled: false }) }, 'scheduler')
          .reason_code
      ).toBe('policy_unreadable_fail_closed');
      expect(decideCommunityAiAutomatedTick(configured({ execution_enabled: false }), 'rpa_retry').reason_code).toBe(
        'execution_disabled'
      );
      expect(decideCommunityAiAutomatedTick(configured({ auto_rules_enabled: false }), 'auto').reason_code).toBe(
        'auto_rules_disabled'
      );
      // CONTROL: auto_rules_enabled only gates the auto tick.
      expect(decideCommunityAiAutomatedTick(configured({ auto_rules_enabled: false }), 'scheduler').allowed).toBe(true);
    });
  });

  it('an unknown initiator is refused initiator_unknown in every state', () => {
    for (const state of ['configured', 'missing_row'] as const) {
      const decision = decideCommunityAiExecutionPolicy(
        { state, policy: row() },
        { initiator: 'cron_x' as unknown as CommunityAiExecutionInitiator, approved_at: APPROVED_AT }
      );
      expect(decision).toMatchObject({ allowed: false, reason_code: 'initiator_unknown' });
    }
  });
});
