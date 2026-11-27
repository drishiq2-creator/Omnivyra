/**
 * Item D (owner decision) — a NEW playbook defaults to browser execution OFF.
 *
 * Real route (/api/community-ai/playbooks) + real playbookService.createPlaybook
 * against a capturing write double; the role gate is a double that applies the
 * allowedRoles list the route passes (MANAGE_PLAYBOOKS), so a route that stopped
 * passing that list, or saved before the gate, fails here.
 *
 * Matrix (requested = caller asked for browser; fallback = executor's API -> browser):
 *   new playbook (any create payload without an explicit flag) -> both refused
 *   existing playbook, key absent                               -> requested refused, fallback allowed (unchanged)
 *   explicit Allowed (true)                                      -> both allowed
 *   explicit Not allowed (false)                                 -> both refused
 */
type Row = Record<string, any>;
const inserted: Row[] = [];
jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: () => {
    let pending: Row | null = null;
    const q: any = {
      insert: (r: Row) => { pending = r; inserted.push(r); return q; },
      update: (r: Row) => { pending = r; return q; },
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: async () => ({ data: pending ? [{ id: 'pb-new', ...pending }] : [], error: null }),
    };
    return q;
  },
}));
jest.mock('../../db/supabaseClient', () => ({ supabase: { from: () => ({}) } }));
let currentRole = 'COMPANY_ADMIN';
jest.mock('../../../pages/api/community-ai/utils', () => ({
  requireTenantScope: jest.fn(async () => ({ tenantId: 'org-1', organizationId: 'org-1' })),
  enforceActionRole: jest.fn(async ({ res, allowedRoles }: any) => {
    if (!allowedRoles.includes(currentRole)) { res.status(403).json({ error: 'FORBIDDEN_ROLE' }); return null; }
    return { userId: 'user-1', role: currentRole };
  }),
}));
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));

import playbooksRoute from '../../../pages/api/community-ai/playbooks/index';
import {
  applyNewPlaybookExecutionModeDefaults,
  playbookExecutionModeDecision,
  type ExecutionModesConfig,
} from '../../services/communityAiExecutionModes';
import { COMMUNITY_AI_CAPABILITIES } from '../../services/rbac/communityAiCapabilities';
import { Role } from '../../services/rbacService';
import { defaultPlaybook } from '../../../components/community-ai/PlaybookEditor';

async function call(method: string, body: Row) {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (p: any) => { res.body = p; return res; };
  await (playbooksRoute as any)({ method, headers: {}, query: {}, body: { tenant_id: 'org-1', organization_id: 'org-1', ...body } }, res);
  return res;
}
const requested = (m: ExecutionModesConfig) => playbookExecutionModeDecision(m, 'browser', 'requested').allowed;
const fallback = (m: ExecutionModesConfig) => playbookExecutionModeDecision(m, 'browser', 'system_fallback').allowed;

beforeEach(() => { inserted.length = 0; currentRole = 'COMPANY_ADMIN'; });

describe('D: new playbooks default to browser OFF', () => {
  it('the editor default for a new playbook is explicit Not allowed', () => {
    const modes = defaultPlaybook('org-1', 'org-1').execution_modes;
    expect(modes.browser_allowed).toBe(false);
    expect(requested(modes)).toBe(false);
    expect(fallback(modes)).toBe(false);
    expect(modes.api_allowed).toBe(true); // other modes unchanged
  });

  it.each([
    ['no execution_modes block', undefined],
    ['null block', null],
    ['block without the key', { api_allowed: true, rpa_allowed: false, manual_only: false }],
    ['block with browser_allowed null ("Not set" chosen on create)', { api_allowed: true, browser_allowed: null }],
  ])('POST with %s stores browser_allowed false -> requested AND fallback refused', async (_l, modes) => {
    const res = await call('POST', { name: 'n', ...(modes === undefined ? {} : { execution_modes: modes }) });
    expect(res.statusCode).toBe(201);
    const stored = inserted[0].execution_modes;
    expect(stored.browser_allowed).toBe(false);
    expect(requested(stored)).toBe(false);
    expect(fallback(stored)).toBe(false);
    // the defaulted block keeps "no block" semantics for every other mode
    expect(playbookExecutionModeDecision(stored, 'api').allowed).toBe(true);
    expect(playbookExecutionModeDecision(stored, 'rpa').allowed).toBe(false);
  });

  it('CONTROL: an admin creating with explicit Allowed stores true -> both allowed', async () => {
    const res = await call('POST', { name: 'n', execution_modes: { api_allowed: true, browser_allowed: true } });
    expect(res.statusCode).toBe(201);
    expect(inserted[0].execution_modes.browser_allowed).toBe(true);
    expect(requested(inserted[0].execution_modes)).toBe(true);
    expect(fallback(inserted[0].execution_modes)).toBe(true);
  });

  it('CONTROL (failing-control pair): without the create default, a keyless block would allow the fallback', () => {
    const keyless = { api_allowed: true, rpa_allowed: false, manual_only: false };
    expect(fallback(keyless)).toBe(true);
    expect(fallback(applyNewPlaybookExecutionModeDefaults(keyless))).toBe(false);
  });

  it('existing playbook without the key: requested refused, fallback still allowed (unchanged by D)', () => {
    const legacy = { api_allowed: true, rpa_allowed: false, manual_only: false };
    expect(requested(legacy)).toBe(false);
    expect(fallback(legacy)).toBe(true);
    expect(fallback(null)).toBe(true); // a legacy row with no block at all
  });

  it('PUT (update) of an existing playbook does not inject the new-playbook default', async () => {
    const res = await call('PUT', { id: 'pb-1', execution_modes: { api_allowed: true } });
    expect(res.statusCode).toBe(200);
    expect(res.body.playbook.execution_modes).toEqual({ api_allowed: true });
    expect(inserted).toHaveLength(0);
  });

  it('explicit Allowed -> both allowed; explicit Not allowed -> both refused', () => {
    expect([requested({ browser_allowed: true }), fallback({ browser_allowed: true })]).toEqual([true, true]);
    expect([requested({ browser_allowed: false }), fallback({ browser_allowed: false })]).toEqual([false, false]);
  });
});

describe('D: only the playbook-managing role can enable browser', () => {
  it('MANAGE_PLAYBOOKS is company admin + super admin only', () => {
    expect([...COMMUNITY_AI_CAPABILITIES.MANAGE_PLAYBOOKS].sort()).toEqual([Role.COMPANY_ADMIN, Role.SUPER_ADMIN].sort());
  });

  it.each(['CONTENT_PUBLISHER', 'CONTENT_REVIEWER', 'CONTENT_CREATOR', 'VIEW_ONLY'])(
    '%s cannot create or update a playbook (so cannot set browser_allowed)', async (role) => {
      currentRole = role;
      const created = await call('POST', { name: 'n', execution_modes: { browser_allowed: true } });
      expect(created.statusCode).toBe(403);
      const updated = await call('PUT', { id: 'pb-1', execution_modes: { browser_allowed: true } });
      expect(updated.statusCode).toBe(403);
      expect(inserted).toHaveLength(0);
    });

  it('CONTROL: COMPANY_ADMIN may enable it', async () => {
    currentRole = Role.COMPANY_ADMIN;
    const res = await call('PUT', { id: 'pb-1', execution_modes: { browser_allowed: true } });
    expect(res.statusCode).toBe(200);
    expect(res.body.playbook.execution_modes.browser_allowed).toBe(true);
  });
});
