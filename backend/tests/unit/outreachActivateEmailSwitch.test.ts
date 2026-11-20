/**
 * POST /api/super-admin/outreach/activate reports the email switch (a9, 2026-11-20; operator screen).
 * emailEnabled mirrors LEAD_OUTREACH_EMAIL_ENABLED exactly as the email transport reads it: DEFAULT OFF - unset, empty,
 * '1', 'yes' are all false; only 'true' (any case) is true. The field is descriptive: the transport still refuses
 * every send while the switch is off.
 */
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/requestAccessService', () => ({ requireAdminRateLimit: async () => true }));
jest.mock('../../security/requireCapability', () => ({ requireCapability: async () => ({ ok: true, principal: { id: 'p1' } }) }));
jest.mock('../../security/platformWriteAuthority', () => ({ requirePlatformWriteAuthority: () => true }));
const run = jest.fn(async (companyId: string, leadId: string) => ({ companyId, leadId, tasks: [], dispatched: 0 }));
jest.mock('../../services/leadOutreachActivation', () => ({ runOutreachActivation: (...a: unknown[]) => (run as any)(...a) }));

import handler from '../../../pages/api/super-admin/outreach/activate';

const saved = process.env.LEAD_OUTREACH_EMAIL_ENABLED;
afterAll(() => { if (saved === undefined) delete process.env.LEAD_OUTREACH_EMAIL_ENABLED; else process.env.LEAD_OUTREACH_EMAIL_ENABLED = saved; });

async function call(env: string | undefined) {
  if (env === undefined) delete process.env.LEAD_OUTREACH_EMAIL_ENABLED; else process.env.LEAD_OUTREACH_EMAIL_ENABLED = env;
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await (handler as any)({ method: 'POST', body: { companyId: 'co-1', leadId: 'lead-1', previewOnly: true }, headers: {} }, res);
  return res;
}

it.each([[undefined], [''], ['false'], ['1'], ['yes'], ['TRUE ']])('LEAD_OUTREACH_EMAIL_ENABLED=%p -> emailEnabled false (default OFF)', async (env) => {
  const res = await call(env as string | undefined);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ ok: true, emailEnabled: false });
});

it.each([['true'], ['TRUE'], ['True']])('CONTROL: LEAD_OUTREACH_EMAIL_ENABLED=%p -> emailEnabled true', async (env) => {
  const res = await call(env);
  expect(res.body).toMatchObject({ ok: true, emailEnabled: true });
});

it('the report is passed through unchanged beside the switch', async () => {
  const res = await call(undefined);
  expect(res.body.report).toEqual({ companyId: 'co-1', leadId: 'lead-1', tasks: [], dispatched: 0 });
  expect(run).toHaveBeenCalledWith('co-1', 'lead-1', expect.objectContaining({ previewOnly: true }));
});
