import { executeAction as executeCommunityAction } from '../../services/communityAiActionExecutor';
import {
  actionLogStore,
  actionStore,
  buildQuery,
  playbookStore,
  resetCommunityAiStores,
  roleStore,
  seedPlaybook,
  tokenStore,
} from './communityAiTestHarness';

jest.mock('../../db/supabaseClient', () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

jest.mock('../../services/rpaWorker/rpaWorkerService', () => ({
  executeRpaTask: jest.fn().mockResolvedValue({ success: true, screenshot_path: 'rpa-shot.png' }),
}));

const { supabase } = jest.requireMock('../../db/supabaseClient');
const { executeRpaTask } = jest.requireMock('../../services/rpaWorker/rpaWorkerService');

describe('Community-AI RPA Execution', () => {
  beforeEach(() => {
    (supabase.from as jest.Mock).mockImplementation((table: string) => buildQuery(table));
    resetCommunityAiStores();
    seedPlaybook({
      execution_modes: {
        api_allowed: true,
        rpa_allowed: true,
        manual_only: false,
      },
    });
    (executeRpaTask as jest.Mock).mockClear();
    (executeRpaTask as jest.Mock).mockResolvedValue({
      success: true,
      screenshot_path: 'rpa-shot.png',
    });
  });

  it('blocks RPA when playbook disallows rpa_allowed', async () => {
    playbookStore.length = 0;
    seedPlaybook({
      id: 'playbook-rpa-block',
      execution_modes: {
        api_allowed: true,
        rpa_allowed: false,
        manual_only: false,
      },
    });
    const result = await executeCommunityAction(
      {
        id: 'rpa-1',
        tenant_id: 'tenant-1',
        organization_id: 'tenant-1',
        platform: 'reddit',
        action_type: 'reply',
        target_id: 'https://reddit.com/r/test/comments/1',
        suggested_text: 'Hello!',
        playbook_id: 'playbook-rpa-block',
        requires_human_approval: false,
        execution_mode: 'rpa',
      },
      true
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('RPA');
    expect(executeRpaTask).not.toHaveBeenCalled();
  });

  it('executes RPA when execution_mode = rpa', async () => {
    const result = await executeCommunityAction(
      {
        id: 'rpa-2',
        tenant_id: 'tenant-1',
        organization_id: 'tenant-1',
        platform: 'reddit',
        action_type: 'reply',
        target_id: 'https://reddit.com/r/test/comments/2',
        suggested_text: 'Hello!',
        playbook_id: 'playbook-1',
        requires_human_approval: false,
        execution_mode: 'rpa',
      },
      true
    );
    expect(result.ok).toBe(true);
    expect(result.response?.screenshot_path).toBe('rpa-shot.png');
  });

  it('enqueues RPA task with expected payload', async () => {
    await executeCommunityAction(
      {
        id: 'rpa-3',
        tenant_id: 'tenant-1',
        organization_id: 'tenant-1',
        platform: 'reddit',
        action_type: 'reply',
        target_id: 'https://reddit.com/r/test/comments/3',
        suggested_text: 'Hello!',
        playbook_id: 'playbook-1',
        requires_human_approval: false,
        execution_mode: 'rpa',
      },
      true
    );
    expect(executeRpaTask).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        organization_id: 'tenant-1',
        platform: 'reddit',
        action_type: 'reply',
        target_url: 'https://reddit.com/r/test/comments/3',
        text: 'Hello!',
        action_id: 'rpa-3',
      })
    );
  });

  it('blocks RPA when playbook limits exceeded', async () => {
    playbookStore.length = 0;
    seedPlaybook({
      id: 'playbook-limit',
      limits: { max_replies_per_hour: 0 },
      execution_modes: {
        api_allowed: true,
        rpa_allowed: true,
        manual_only: false,
      },
    });
    const result = await executeCommunityAction(
      {
        id: 'rpa-4',
        tenant_id: 'tenant-1',
        organization_id: 'tenant-1',
        platform: 'reddit',
        action_type: 'reply',
        target_id: 'https://reddit.com/r/test/comments/4',
        suggested_text: 'Hello!',
        playbook_id: 'playbook-limit',
        requires_human_approval: false,
        execution_mode: 'rpa',
      },
      true
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Playbook limit exceeded');
    expect(executeRpaTask).not.toHaveBeenCalled();
  });
});
