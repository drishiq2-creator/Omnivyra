/**
 * Phase C — execution-mode allowlist + playbook/policy enforcement.
 *
 *   validator : closed enum; rpa/browser need a playbook that explicitly permits
 *               them; browser is checked like rpa.
 *   executor  : unknown mode fail-closed; rpa needs a permitting playbook for
 *               every source; API->browser fallback only where browser is
 *               permitted; an rpa run on a non-worker is "queued, not attempted".
 *   route     : unknown mode 400 before any read; requires_approval honoured;
 *               playbook limits read real history; queued rpa = 202.
 *
 * Every refusal has a CONTROL differing in one input that must get through.
 */
import { validateActionAgainstPlaybook } from '../../services/playbooks/playbookValidator';
import { EXECUTION_MODES, playbookExecutionModeDecision } from '../../services/communityAiExecutionModes';

// ─────────────────────────────── validator ────────────────────────────────
describe('validator: closed mode enum and explicit rpa/browser permission', () => {
  const v = (mode: unknown, playbook: any) =>
    validateActionAgainstPlaybook({ action_type: 'like', text: '', execution_mode: mode as string, risk_level: 'low' }, playbook, null);

  it('the enum is exactly the four modes the executor implements', () => {
    expect([...EXECUTION_MODES]).toEqual(['manual', 'api', 'rpa', 'browser']);
  });

  it.each(['telepathy', 'RPA2', 'auto', 'selenium'])('unknown mode %s is refused (with or without a playbook)', (m) => {
    expect(v(m, null)).toMatchObject({ allowed: false, reason: 'EXECUTION_MODE_INVALID' });
    expect(v(m, { execution_modes: { rpa_allowed: true, browser_allowed: true, api_allowed: true } }))
      .toMatchObject({ allowed: false, reason: 'EXECUTION_MODE_INVALID' });
  });

  it.each(['rpa', 'browser'])('no playbook + %s -> PLAYBOOK_REQUIRED', (m) => {
    expect(v(m, null)).toMatchObject({ allowed: false, reason: 'PLAYBOOK_REQUIRED' });
  });

  it.each(['manual', 'api', '', null, 'MANUAL'])('CONTROL: no playbook + %p is allowed', (m) => {
    expect(v(m, null).allowed).toBe(true);
  });

  it('rpa: a playbook with no execution_modes block does NOT permit it (was: unchecked)', () => {
    expect(v('rpa', { action_rules: { allow_like: true } })).toMatchObject({ allowed: false, reason: 'RPA execution is not permitted by playbook.' });
    expect(v('rpa', { execution_modes: { rpa_allowed: true } }).allowed).toBe(true); // CONTROL
  });

  it('browser is checked like rpa: needs browser_allowed === true', () => {
    expect(v('browser', { execution_modes: { api_allowed: true, rpa_allowed: true, manual_only: false } }))
      .toMatchObject({ allowed: false, reason: 'Browser execution is not permitted by playbook.' });
    expect(v('browser', { execution_modes: { manual_only: true, browser_allowed: true } }))
      .toMatchObject({ allowed: false, reason: 'Execution mode not permitted by playbook.' });
    expect(v('browser', { execution_modes: { browser_allowed: true } }).allowed).toBe(true); // CONTROL
  });

  it('api keeps its historical rule (allowed without a block, refused when api_allowed is false)', () => {
    expect(v('api', { action_rules: { allow_like: true } }).allowed).toBe(true);
    expect(v('api', { execution_modes: { api_allowed: false } }).allowed).toBe(false);
    expect(playbookExecutionModeDecision(undefined, 'manual')).toEqual({ allowed: true });
  });
});

// ─────────────────────────────── executor ─────────────────────────────────
jest.mock('../../services/communityAiContactGovernanceGate', () => ({
  checkCommunityActionContactGovernance: jest.fn(async () => ({ allowed: true, reason: 'not_suppressed', checked: 1 })),
  contactGateAuditPayload: jest.fn(() => ({})),
}));
jest.mock('../../db/supabaseClient', () => {
  const chain: any = new Proxy({}, {
    get: (_t, k) => (k === 'then'
      ? (ok: any, ko: any) => Promise.resolve({ data: [], error: null }).then(ok, ko)
      : () => chain),
  });
  return { supabase: { from: jest.fn(() => chain), rpc: jest.fn(async () => ({ data: null, error: null })) } };
});
jest.mock('../../services/communityAiPlatformPolicyService', () =>
  jest.requireActual('../helpers/communityAiPolicyMock').policyServiceMock(() => ({ execution_enabled: true, auto_rules_enabled: true, require_human_approval: false })));
jest.mock('../../services/usageEnforcementService', () => ({ checkUsageBeforeExecution: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../../services/communityAiNotificationService', () => ({ notifyCommunityAi: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiWebhookService', () => ({ sendCommunityAiWebhooks: jest.fn(async () => undefined) }));
jest.mock('../../services/communityAiActionLogService', () => ({ logCommunityAiActionEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageLedgerService', () => ({ logUsageEvent: jest.fn(async () => undefined) }));
jest.mock('../../services/usageMeterService', () => ({ incrementUsageMeter: jest.fn(async () => undefined) }));
jest.mock('../../services/platformTokenService', () => ({ getToken: jest.fn(async () => ({ access_token: 'test-token' })) }));
const rpaTask = jest.fn(async (): Promise<any> => ({ success: true }));
jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({ executeRpaTask: (...a: unknown[]) => (rpaTask as any)(...a) }));
const connector = jest.fn(async (): Promise<any> => ({ success: true, platform_id: 'urn:li:like:1' }));
jest.mock('../../services/platformConnectors/linkedinConnector', () => ({ executeAction: (...a: unknown[]) => (connector as any)(...a) }));
let currentPlaybook: any = null;
jest.mock('../../services/playbooks/playbookService', () => ({ getPlaybookById: jest.fn(async () => currentPlaybook) }));

import { executeAction } from '../../services/communityAiActionExecutorRuntime';

const act = (over: Record<string, unknown> = {}) => ({
  id: 'a-1', tenant_id: 'org-1', organization_id: 'org-1', platform: 'linkedin', action_type: 'like' as const,
  target_id: 'urn:li:share:1', suggested_text: null, playbook_id: null as string | null, approved_at: '2026-11-01T00:00:00Z',
  ...over,
});
const run = (over: Record<string, unknown>, source: 'manual' | 'auto' | 'scheduler' = 'manual') =>
  executeAction(act(over) as any, true, { source, notify: false, webhook: false });

describe('executor: fail-closed mode + playbook rules', () => {
  beforeEach(() => {
    rpaTask.mockClear().mockImplementation(async () => ({ success: true }));
    connector.mockClear().mockImplementation(async () => ({ success: true, platform_id: 'urn:li:like:1' }));
    currentPlaybook = null;
  });

  it('an unknown declared mode is refused; nothing is called (was: re-routed to api/browser)', async () => {
    const r = await run({ execution_mode: 'telepathy' });
    expect(r).toMatchObject({ ok: false, status: 'failed', error: 'EXECUTION_MODE_INVALID' });
    expect(connector).not.toHaveBeenCalled();
    expect(rpaTask).not.toHaveBeenCalled();
    const ok = await run({ execution_mode: 'manual' }); // CONTROL
    expect(ok).toMatchObject({ ok: true, status: 'sent_unverified' });
  });

  it('rpa from the MANUAL source with no playbook -> PLAYBOOK_REQUIRED, never executed (was: ran)', async () => {
    const r = await run({ execution_mode: 'rpa' }, 'manual');
    expect(r).toMatchObject({ ok: false, error: 'PLAYBOOK_REQUIRED' });
    expect(rpaTask).not.toHaveBeenCalled();
  });

  it('rpa with a playbook that does not permit rpa -> refused', async () => {
    currentPlaybook = { execution_modes: { api_allowed: true, rpa_allowed: false, manual_only: false } };
    const r = await run({ execution_mode: 'rpa', playbook_id: 'pb-1' });
    expect(r).toMatchObject({ ok: false, error: 'RPA execution is not permitted by playbook.' });
    expect(rpaTask).not.toHaveBeenCalled();
  });

  it('CONTROL: rpa with a playbook that permits rpa reaches executeRpaTask', async () => {
    currentPlaybook = { execution_modes: { rpa_allowed: true } };
    const r = await run({ execution_mode: 'rpa', playbook_id: 'pb-1' });
    expect(rpaTask).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, status: 'executed' });
  });

  it('rpa on a non-worker: queued for the worker, reported as not attempted (no launch here)', async () => {
    currentPlaybook = { execution_modes: { rpa_allowed: true } };
    rpaTask.mockImplementation(async () => ({ success: false, not_attempted: true, queued_for_worker: true, error: 'BROWSER_RUNTIME_NOT_WORKER:QUEUED_FOR_WORKER' }));
    const r = await run({ execution_mode: 'rpa', playbook_id: 'pb-1' });
    expect(r).toMatchObject({ ok: false, status: 'failed', error: 'RPA_QUEUED_FOR_WORKER', reason: 'NOT_ATTEMPTED' });
    expect(r.response).toMatchObject({ not_attempted: true, queued_for_worker: true });
  });

  it('automated browser with a playbook lacking browser_allowed -> refused; CONTROL: permitted -> dispatched', async () => {
    currentPlaybook = { execution_modes: { api_allowed: true, rpa_allowed: true } };
    const refused = await run({ execution_mode: 'browser', playbook_id: 'pb-1' }, 'scheduler');
    expect(refused).toMatchObject({ ok: false, error: 'Browser execution is not permitted by playbook.' });
    currentPlaybook = { execution_modes: { browser_allowed: true } };
    const ok = await run({ execution_mode: 'browser', playbook_id: 'pb-1' }, 'scheduler');
    expect(ok).toMatchObject({ ok: true, status: 'dispatched' });
  });

  it('documented exception: a human-initiated, playbook-less browser dispatch (engagement DM path) still dispatches', async () => {
    const r = await run({ execution_mode: 'browser', action_type: 'dm', suggested_text: 'hi', target_id: 'https://www.linkedin.com/messaging/thread/2-abc/' }, 'manual');
    expect(r).toMatchObject({ ok: true, status: 'dispatched' });
    const auto = await run({ execution_mode: 'browser' }, 'auto'); // CONTROL: automated, no playbook
    expect(auto).toMatchObject({ ok: false, error: 'PLAYBOOK_REQUIRED' });
  });

  it('API failure does not fall back to browser unless the playbook permits browser', async () => {
    connector.mockImplementation(async () => ({ success: false, error: 'API_DOWN' }));
    currentPlaybook = { execution_modes: { api_allowed: true } };
    const refused = await run({ execution_mode: 'api', playbook_id: 'pb-1' }, 'scheduler');
    expect(refused).toMatchObject({ ok: false, status: 'failed', error: 'API_DOWN' });
    expect(refused.response).toMatchObject({ fallback_refused: 'BROWSER_NOT_PERMITTED_BY_PLAYBOOK' });
    currentPlaybook = { execution_modes: { api_allowed: true, browser_allowed: true } }; // CONTROL
    const fellBack = await run({ execution_mode: 'api', playbook_id: 'pb-1' }, 'scheduler');
    expect(fellBack).toMatchObject({ ok: true, status: 'dispatched' });
    expect(fellBack.response).toMatchObject({ fallback_from: 'api' });
  });

  it('CONTROL (unchanged): manual-source api without a playbook still falls back to browser', async () => {
    connector.mockImplementation(async () => ({ success: false, error: 'API_DOWN' }));
    const r = await run({ execution_mode: 'api' }, 'manual');
    expect(r).toMatchObject({ ok: true, status: 'dispatched' });
  });
});
