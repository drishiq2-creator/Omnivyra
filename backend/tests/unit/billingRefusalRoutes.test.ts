/**
 * Route wiring for LIVE billing refusals (04, 2026-11-20). The billed call (runBilledAiCompletion) is made to refuse
 * with a real BillingRefusalError; the routes must:
 *   - chat-brief: answer 402/403 + `code`, and a NON-billing failure a generic 500 (the internal message used to reach
 *     the user verbatim);
 *   - campaign-content/assist and creator-templates/field-assist: keep their deterministic fallback but FLAG it
 *     (billing_refusal_code); a non-billing AI failure falls back with NO flag.
 * Services are stubbed with the real contract: call the llm closure, fall back on any throw.
 */
let billedMode: 'refuse' | 'boom' | 'ok' = 'refuse';
let refusalCode = 'INSUFFICIENT_CREDITS';

jest.mock('../../services/billing/runBilledAiCompletion', () => {
  const actual = jest.requireActual('../../services/billing/runBilledAiCompletion');
  return {
    ...actual,
    runBilledAiCompletion: jest.fn(async () => {
      if (billedMode === 'refuse') throw new actual.BillingRefusalError(refusalCode, 'x');
      if (billedMode === 'boom') throw new Error('[runBilledAiCompletion] orchestrator did not execute: status=error');
      return { text: '{"reply":"ok","brief":{}}' };
    }),
  };
});
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: jest.fn(async () => ({ userId: 'u1', defaultCompanyId: 'co' })),
  enforceCompanyAccess: jest.fn(async () => true),
}));
jest.mock('../../services/context/canonicalContentContextResolver', () => ({
  resolveCompanyGroundingGuard: jest.fn(async () => ({ directive: '' })),
}));
jest.mock('../../services/creator/creatorCopyContextResolver', () => ({
  resolveCreatorCopyContext: jest.fn(async () => ({ company: {}, brandVoice: {} })),
}));
jest.mock('../../services/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
const fallbackRun = (out: any) => async ({ llm }: any) => {
  try { await llm([]); return { ...out, usedFallback: false }; } catch { return { ...out, usedFallback: true, fallbackReason: 'llm_error' }; }
};
jest.mock('../../services/campaign/campaignContentAssistService', () => ({
  validateContentAssistRequest: () => ({ ok: true, request: { action: 'shorten', content: 'abc', platform: null } }),
  runCampaignContentAssist: jest.fn((args: any) => fallbackRun({ proposals: ['basic'] })(args)),
}));
jest.mock('../../services/creator/creatorFieldAssistService', () => ({
  validateFieldAssistRequest: () => ({ ok: true, request: { templateId: 't', action: 'generate', targets: [{ scope: 'brief', fieldKey: 'k' }], context: {} } }),
  loadTemplateForAssist: jest.fn(async () => ({ id: 't' })),
  runCreatorFieldAssist: jest.fn((args: any) => fallbackRun({ updates: [{ scope: 'brief', fieldKey: 'k', value: 'basic' }], invalidTargets: [], violations: [] })(args)),
}));

import chatBrief from '../../../pages/api/creator-templates/chat-brief';
import assist from '../../../pages/api/campaign-content/assist';
import fieldAssist from '../../../pages/api/creator-templates/field-assist';

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
async function call(h: any, body: Record<string, unknown>) {
  const res = mockRes();
  await h({ method: 'POST', body: { company_id: 'co', ...body }, headers: {}, query: {} }, res);
  return res;
}
let errSpy: jest.SpyInstance;
beforeEach(() => { billedMode = 'refuse'; refusalCode = 'INSUFFICIENT_CREDITS'; errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => errSpy.mockRestore());

describe('chat-brief', () => {
  it.each<[string, number]>([['INSUFFICIENT_CREDITS', 402], ['NO_CREDIT_ACCOUNT', 402], ['ORG_SCOPE_VIOLATION', 403], ['ORG_CONTROL_BLOCKED', 403]])(
    'a billing refusal (%s) answers %d + code, never the internal message', async (code, status) => {
      refusalCode = code;
      const res = await call(chatBrief, { messages: [{ role: 'user', content: 'hi' }] });
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ error: 'Billing refused', code });
    });

  it('a NON-billing failure is a generic 500 (the raw "[runBilledAiCompletion] …" text used to reach the user)', async () => {
    billedMode = 'boom';
    const res = await call(chatBrief, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'chat brief failed' });
    expect(JSON.stringify(res.body)).not.toMatch(/runBilledAiCompletion|orchestrator|status=/);
  });
});

describe.each<[string, any, string]>([
  ['campaign-content/assist', assist, 'proposals'],
  ['creator-templates/field-assist', fieldAssist, 'updates'],
])('%s', (_n, handler, key) => {
  it('a billing refusal keeps the deterministic fallback but FLAGS it (billing_refusal_code)', async () => {
    const res = await call(handler, {});
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ used_fallback: true, billing_refusal_code: 'INSUFFICIENT_CREDITS' });
    expect(Array.isArray(res.body[key])).toBe(true);
  });

  it('control: a NON-billing AI failure falls back WITHOUT the flag (it is not a credits problem)', async () => {
    billedMode = 'boom';
    const res = await call(handler, {});
    expect(res.body.used_fallback).toBe(true);
    expect(res.body.billing_refusal_code).toBeUndefined();
  });

  it('control: a successful AI call carries no flag and no fallback', async () => {
    billedMode = 'ok';
    const res = await call(handler, {});
    expect(res.body.used_fallback).toBe(false);
    expect(res.body.billing_refusal_code).toBeUndefined();
  });
});
