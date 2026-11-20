/**
 * Cross-tenant write (2026-11-18): upsertOnboardingTemplate updated enterprise_onboarding_templates by `id` ALONE.
 * listOnboardingTemplates returns every caller the ids of shared templates (another tenant's shared rows AND the
 * NULL-org platform presets), so a MANAGE_LISTENING_CAPABILITIES holder in company A could rewrite company B's
 * shared template - or a platform preset every tenant reads. The update is now scoped to the caller's organization.
 *
 * The fake is a STATEFUL table that really applies each .eq() filter, so these tests assert the rows themselves
 * (B's row unchanged), not merely which filters were called.
 */
type Row = Record<string, unknown>;
let mockRows: Row[] = [];

jest.mock('../../db/writeOwner', () => ({
  ownedDbTable: (table: string) => {
    if (table !== 'enterprise_onboarding_templates') throw new Error(`unexpected table ${table}`);
    const filters: Array<[string, unknown]> = [];
    let patch: Row | null = null;
    let insertRow: Row | null = null;
    const matches = (r: Row) => filters.every(([c, v]) => r[c] === v);
    const q: any = {
      update: (p: Row) => { patch = p; return q; },
      insert: (r: Row) => { insertRow = r; return q; },
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
      select: () => q,
      maybeSingle: async () => {
        const hit = mockRows.filter(matches);
        if (hit.length > 1) return { data: null, error: { message: 'multiple rows' } };
        if (hit.length === 0) return { data: null, error: null };
        Object.assign(hit[0], patch);
        return { data: { ...hit[0] }, error: null };
      },
      single: async () => {
        if (insertRow) {
          const row = { id: `new-${mockRows.length}`, ...insertRow };
          mockRows.push(row);
          return { data: row, error: null };
        }
        const hit = mockRows.filter(matches);
        if (hit.length !== 1) return { data: null, error: { message: `expected 1 row, got ${hit.length}` } };
        Object.assign(hit[0], patch);
        return { data: { ...hit[0] }, error: null };
      },
    };
    return q;
  },
}));

import { upsertOnboardingTemplate, OnboardingTemplateNotFoundError } from '../../services/enterpriseOnboardingService';

const CO_A = 'c0a00000-0000-4000-8000-00000000000a';
const CO_B = 'c0b00000-0000-4000-8000-00000000000b';
const original = (id: string, org: string | null, shared: boolean): Row => ({
  id, organization_id: org, template_kind: 'industry_preset', name: `orig-${id}`, industry: null,
  description: 'original', payload: { v: 'original' }, recommended_explanation: 'original', shared, owner_user_id: 'owner-orig',
});
const attack = (id: string) => upsertOnboardingTemplate({
  organizationId: CO_A, id, templateKind: 'industry_preset' as any, name: 'HIJACKED', description: 'x',
  payload: { v: 'attacker' }, recommendedExplanation: 'x', shared: false, ownerUserId: 'attacker-user',
});

beforeEach(() => {
  mockRows = [
    original('tpl-b-shared', CO_B, true), // another tenant's SHARED template (listed to everyone)
    original('tpl-platform', null, true), // a NULL-org platform preset every tenant reads
    original('tpl-a-own', CO_A, false),   // the caller's own template
  ];
});
const row = (id: string) => mockRows.find((r) => r.id === id)!;

describe('upsertOnboardingTemplate: an update never reaches another organization\'s template', () => {
  it("company A cannot overwrite company B's SHARED template by id: refused, B's row unchanged", async () => {
    const before = { ...row('tpl-b-shared') };
    await expect(attack('tpl-b-shared')).rejects.toBeInstanceOf(OnboardingTemplateNotFoundError);
    expect(row('tpl-b-shared')).toEqual(before);
  });

  it('company A cannot overwrite a NULL-org PLATFORM preset by id: refused, the preset unchanged', async () => {
    const before = { ...row('tpl-platform') };
    await expect(attack('tpl-platform')).rejects.toBeInstanceOf(OnboardingTemplateNotFoundError);
    expect(row('tpl-platform')).toEqual(before);
  });

  it('POSITIVE CONTROL: company A still updates its OWN template', async () => {
    const out = await attack('tpl-a-own');
    expect(out).toMatchObject({ id: 'tpl-a-own', organization_id: CO_A, name: 'HIJACKED', owner_user_id: 'attacker-user' });
    expect(row('tpl-a-own')).toMatchObject({ name: 'HIJACKED', payload: { v: 'attacker' } });
  });

  it('CONTROL: a create (no id) is stamped with the caller organization, never another', async () => {
    const out = await upsertOnboardingTemplate({
      organizationId: CO_A, templateKind: 'industry_preset' as any, name: 'new', payload: {}, ownerUserId: 'u',
    });
    expect(out).toMatchObject({ organization_id: CO_A });
  });
});
