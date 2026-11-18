import type { NextApiRequest, NextApiResponse } from 'next';

jest.mock('../../services/campaignAiOrchestrator', () => ({
  runCampaignAiPlan: jest.fn().mockResolvedValue({
    mode: 'generate_plan',
    snapshot_hash: 'hash123',
    raw_plan_text: 'Test campaign plan output',
    omnivyre_decision: {
      recommendation: 'HOLD',
      confidence: 0.7,
    },
    plan: {
      weeks: [
        {
          week: 1,
          theme: 'Launch',
          phase_label: 'Launch',
          primary_objective: 'Launch objective',
          platform_allocation: { linkedin: 8 },
          content_type_mix: ['8 post'],
          cta_type: 'None',
          total_weekly_content_count: 8,
          weekly_kpi_focus: 'Reach growth',
          daily: [
            {
              day: 'Monday',
              objective: 'Introduce campaign',
              content: 'Post announcement',
              platforms: { linkedin: 'Post announcement' },
            },
          ],
        },
      ],
    },
  }),
  CampaignAiMode: {},
  normalizeCapacityCounts: jest.fn((value) => value),
  normalizeCapacityCountsWithBreakdown: jest.fn((value) => value),
}));

jest.mock('../../db/campaignPlanStore', () => ({
  __esModule: true,
  saveAiCampaignPlan: jest.fn(),
  saveDraftBlueprint: jest.fn(),
  getLatestDraftPlan: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/viralityAdvisorService', () => ({
  assessVirality: jest.fn(),
}));

jest.mock('../../services/omnivyreClient', () => ({
  requestDecision: jest.fn(),
  buildDecideRequest: jest.fn((payload: any) => payload),
}));

jest.mock('../../services/viralitySnapshotBuilder', () => ({
  buildCampaignSnapshotWithHash: jest.fn().mockResolvedValue({
    snapshot: {
      snapshot_id: 'snap123',
      domain_type: 'campaign',
      state_payload: { campaign_id: 'camp123' },
      metadata: { owner_id: 'test' },
      timestamp: '2026-01-01T00:00:00Z',
    },
    snapshot_hash: 'hash123',
  }),
  canonicalJsonStringify: jest.fn((v) => JSON.stringify(v)),
}));

jest.mock('../../services/campaignPlanningInputsService', () => ({
  getCampaignPlanningInputs: jest.fn().mockResolvedValue(null),
  saveCampaignPlanningInputs: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../db/supabaseClient', () => ({
  supabase: {
    from: jest.fn((table: string) => {
      if (table === 'campaign_versions') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: { company_id: '00000000-0000-4000-8000-000000000123' }, error: null }),
        };
      }

      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
    }),
  },
}));

// ROUTE-AUTH-001 (STEP 3AH-85): /api/campaigns/ai/plan now binds the campaign to the
// caller through requireCampaignAccess (and 403s a mismatched client companyId). These
// suites pin planning behaviour, so the binder grants the fixture campaign to comp123;
// the deny paths are covered by routeAuth001CampaignBinding2Planner.
jest.mock('../../services/campaignAccessService', () => ({
  requireCampaignAccess: jest.fn(async (_req: unknown, _res: unknown, campaignId: string) =>
    ({ userId: 'user-1', companyId: '00000000-0000-4000-8000-000000000123', campaignId })),
}));
jest.mock('../../services/rbacService', () => ({
  getUserCompanyRole: jest.fn().mockResolvedValue({ userId: 'user-1', role: 'COMPANY_ADMIN' }),
  getCompanyRoleIncludingInvited: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/campaignRoleService', () => ({
  resolveEffectiveCampaignRole: jest.fn().mockResolvedValue({ userId: 'user-1', role: 'COMPANY_ADMIN' }),
  isCompanyOverrideRole: jest.fn().mockReturnValue(true),
}));

jest.mock('../../services/deterministicWeeklySkeleton', () => ({
  __esModule: true,
  buildDeterministicWeeklySkeleton: jest.fn().mockResolvedValue({
    total_weekly_content_count: 8,
    platform_allocation: { linkedin: 8 },
    content_type_mix: ['8 post'],
    execution_items: [
      {
        content_type: 'post',
        platform_options: ['linkedin'],
        selected_platforms: ['linkedin'],
        count_per_week: 8,
        topic_slots: Array.from({ length: 8 }, (_, idx) => ({
          topic: `Test topic ${idx + 1}`,
          progression_step: idx + 1,
          global_progression_index: idx + 1,
          intent: {
            objective: 'Launch objective',
            cta_type: 'None',
            target_audience: 'Professionals',
            writing_angle: 'clear, practical',
            brief_summary: 'Kickoff content plan',
            strategic_role: 'Authority Building',
            pain_point: 'Test pain',
            outcome_promise: 'Test outcome',
            audience_stage: 'problem_aware',
            recommendation_alignment: {
              source_type: 'primary_topic',
              source_value: 'Test',
              alignment_reason: 'Test',
            },
          },
        })),
      },
    ],
  }),
}));

jest.mock('../../services/campaignPlanParser', () => ({
  __esModule: true,
  parseAiPlanToWeeks: jest.fn(),
  parseAiRefinedDay: jest.fn(),
  parseAiPlatformCustomization: jest.fn(),
}));

jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockImplementation((args: any) => {
            // campaignPlanParser.parseAiPlanToWeeks uses response_format: { type: 'json_object' }.
            // campaignAiOrchestrator plan generation does not.
            if (args?.response_format?.type === 'json_object') {
              return Promise.resolve({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        weeks: [
                          {
                            week: 1,
                            phase_label: 'Launch',
                            primary_objective: '',
                            platform_allocation: { linkedin: 1 },
                            content_type_mix: [],
                            cta_type: 'None',
                            total_weekly_content_count: 1,
                            weekly_kpi_focus: 'Reach growth',
                            theme: 'Launch',
                            topics_to_cover: ['Introduce campaign'],
                            daily: [
                              {
                                day: 'Monday',
                                objective: 'Introduce campaign',
                                content: 'Post announcement',
                                platforms: { linkedin: 'Post announcement' },
                              },
                            ],
                          },
                        ],
                      }),
                    },
                  },
                ],
              });
            }
            return Promise.resolve({
              choices: [{ message: { content: 'Test campaign plan output' } }],
            });
          }),
        },
      },
    })),
  };
});

const createMockRes = () => {
  const res: Partial<NextApiResponse> & { json: jest.Mock } = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return res as NextApiResponse;
};

describe('Campaign AI Plan Structured', () => {
  it('persists and returns structured plan', async () => {
    const { assessVirality } = require('../../services/viralityAdvisorService');
    const { requestDecision } = require('../../services/omnivyreClient');
    const { saveAiCampaignPlan, saveDraftBlueprint } = require('../../db/campaignPlanStore');

    (assessVirality as jest.Mock).mockResolvedValue({
      snapshot_hash: 'hash123',
      model_version: 'v1',
      diagnostics: {
        asset_coverage: {},
        platform_opportunity: {},
        engagement_readiness: {},
      },
      comparisons: {},
      overall_summary: 'ok',
    });

    (requestDecision as jest.Mock).mockResolvedValue({
      decision_id: 'dec123',
      recommendation: 'HOLD',
      confidence: 0.7,
      explanation: 'test explanation',
      guardrails_triggered: [],
      required_actions: [],
      trace_id: 'trace123',
      policy_version: 'default',
      timestamp: '2026-01-01T00:00:00Z',
    });

    const req = {
      method: 'POST',
      body: {
        campaignId: 'camp123',
        companyId: '00000000-0000-4000-8000-000000000123',
        mode: 'generate_plan',
        message: 'generate plan',
        durationWeeks: 12,
        collectedPlanningContext: {
          target_audience: 'Professionals',
          audience_professional_segment: 'Managers',
          communication_style: 'Professional & expert',
          action_expectation: 'Visit website',
          content_depth: 'Medium detail',
          topic_continuity: 'Mix of both',
          available_content: { post: 0, video: 0, blog: 0, story: 0, thread: 0 },
          tentative_start: '2026-08-15',
          content_capacity: { post: 8, video: 0, blog: 0, story: 0, thread: 0 },
          campaign_duration: 12,
          platforms: 'linkedin',
          platform_content_requests: { linkedin: { post: 8 } },
          exclusive_campaigns: [],
          key_messages: 'Test key messages',
        },
      },
    } as unknown as NextApiRequest;

    const res = createMockRes();

    const handler = (await import('../../../pages/api/campaigns/ai/plan')).default;
    await handler(req, res);

    expect(saveAiCampaignPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'camp123',
        snapshot_hash: 'hash123',
        omnivyre_decision: expect.objectContaining({
          recommendation: 'HOLD',
        }),
        response: 'Test campaign plan output',
      })
    );

    expect(saveDraftBlueprint).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'camp123',
        blueprint: expect.objectContaining({
          campaign_id: 'camp123',
          weeks: expect.arrayContaining([
            expect.objectContaining({
              week_number: 1,
              phase_label: 'Launch',
              primary_objective: 'Launch objective',
            }),
          ]),
        }),
      })
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.plan).toBeDefined();
    expect(payload.plan.weeks).toBeDefined();
    expect(payload.plan.weeks.length).toBeGreaterThan(0);
    expect(payload.plan.weeks[0].week).toBe(1);
    expect(payload.plan.weeks[0].theme || payload.plan.weeks[0].phase_label).toBe('Launch');
  });

  // 7c (2026-11-19): the draft save is NON-blocking, but a seam fan-out it throws must still raise the alertable
  // server signal (ERROR log tenant_parent_fanout + counter tenant_parent_fanout_total{table}) - once - and the
  // request still succeeds.
  it('a fan-out thrown by the non-blocking draft save fires the fanout log + counter once and the request still succeeds', async () => {
    const { assessVirality } = require('../../services/viralityAdvisorService');
    const { requestDecision } = require('../../services/omnivyreClient');
    const { saveDraftBlueprint } = require('../../db/campaignPlanStore');
    const { TenantSeamError } = require('../../db/tenantTable');
    const { logger } = require('../../services/logger');
    const { registry } = require('../../observability/registry');
    (assessVirality as jest.Mock).mockResolvedValue({
      snapshot_hash: 'hash123', model_version: 'v1',
      diagnostics: { asset_coverage: {}, platform_opportunity: {}, engagement_readiness: {} },
      comparisons: {}, overall_summary: 'ok',
    });
    (requestDecision as jest.Mock).mockResolvedValue({
      decision_id: 'dec123', recommendation: 'HOLD', confidence: 0.7, explanation: 'test explanation',
      guardrails_triggered: [], required_actions: [], trace_id: 'trace123', policy_version: 'default', timestamp: '2026-01-01T00:00:00Z',
    });
    (saveDraftBlueprint as jest.Mock).mockReset();
    (saveDraftBlueprint as jest.Mock).mockRejectedValueOnce(
      new TenantSeamError('TENANT_PARENT_FANOUT', 'campaign_week_plan: parent key matches more than 50 campaigns rows (availability limit, not a tenant mismatch)'),
    );
    const fanoutCount = (): number => registry.counterEntries()
      .filter((e: any) => e.name === 'tenant_parent_fanout_total' && e.labels?.table === 'campaign_week_plan')
      .reduce((n: number, e: any) => n + e.value, 0);
    const before = fanoutCount();
    const errSpy = jest.spyOn(logger, 'error');
    try {
      const req = {
        method: 'POST',
        body: {
          campaignId: 'camp123',
          companyId: '00000000-0000-4000-8000-000000000123',
          mode: 'generate_plan',
          message: 'generate plan',
          durationWeeks: 12,
          collectedPlanningContext: {
            target_audience: 'Professionals', audience_professional_segment: 'Managers',
            communication_style: 'Professional & expert', action_expectation: 'Visit website',
            content_depth: 'Medium detail', topic_continuity: 'Mix of both',
            available_content: { post: 0, video: 0, blog: 0, story: 0, thread: 0 },
            tentative_start: '2026-08-15',
            content_capacity: { post: 8, video: 0, blog: 0, story: 0, thread: 0 },
            campaign_duration: 12, platforms: 'linkedin', platform_content_requests: { linkedin: { post: 8 } },
            exclusive_campaigns: [], key_messages: 'Test key messages',
          },
        },
      } as unknown as NextApiRequest;
      const res = createMockRes();
      const handler = (await import('../../../pages/api/campaigns/ai/plan')).default;
      await handler(req, res);

      expect(saveDraftBlueprint).toHaveBeenCalledTimes(1); // the save ran and threw (control)
      expect(res.status).toHaveBeenCalledWith(200);
      expect((res.json as jest.Mock).mock.calls[0][0].plan.weeks.length).toBeGreaterThan(0);
      const fanoutLogs = errSpy.mock.calls.filter((c) => c[0] === 'tenant_parent_fanout');
      expect(fanoutLogs).toEqual([['tenant_parent_fanout', { table: 'campaign_week_plan', parentTable: 'campaigns', key: 'id', limit: 50 }]]);
      expect(fanoutCount() - before).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
