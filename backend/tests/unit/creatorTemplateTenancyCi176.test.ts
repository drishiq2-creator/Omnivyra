/**
 * CI-176 (HIGH, 2026-11-20): a USER creator template belongs to one company.
 * Before: a member of company A who put company B's template UUID in A's plan / asset had it loaded BY ID ALONE
 * (plan validation, the render worker, inline + engine renders) and A rendered with B's design; once B's template
 * sat in a process's registry, A's render resolved it with no read at all; and POST /api/creator-templates/user with
 * source_template_id = B's id cloned B's template into A.
 * REAL: userTemplateService, userTemplateTenancy, campaignPlanValidationService, lib/creator-templates registry.
 * FAKED: the DB (in-memory rows, honouring every .eq filter; every query recorded).
 */
export {};
type Row = Record<string, any>;
const mockRows: Record<string, Row[]> = {};
const mockQueries: Array<{ table: string; op: string; filters: Array<[string, unknown]> }> = [];
jest.mock('../../db/supabaseClient', () => {
  const builder = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let op = 'select';
    let payload: Row | null = null;
    const rows = () => (mockRows[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
    const record = () => mockQueries.push({ table, op, filters: [...filters] });
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
      order: () => { record(); return Promise.resolve({ data: rows(), error: null }); },
      maybeSingle: () => {
        record();
        if (op === 'insert') { const row = { id: 'ut-new', ...payload }; (mockRows[table] ??= []).push(row); return Promise.resolve({ data: row, error: null }); }
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      insert: (p: Row) => { op = 'insert'; payload = p; return b; },
      update: () => { op = 'update'; return b; },
      then: (ok: any, ko: any) => { record(); return Promise.resolve({ data: null, error: null }).then(ok, ko); },
    };
    return b;
  };
  return { supabase: { from: (t: string) => builder(t) } };
});
jest.mock('../../services/creator/userTemplatePreviewService', () => ({ generateUserTemplatePreview: async () => ({}) }), { virtual: false });

jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/userContextService', () => ({
  resolveUserContext: async () => ({ userId: 'u-b', defaultCompanyId: 'co-b-synthetic' }),
  enforceCompanyAccess: async () => ({ userId: 'u-b' }),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const lib = require('../../../lib/creator-templates');
const { cloneTemplate } = require('../../../lib/creator-templates/userTemplate');
const svc = require('../../services/creator/userTemplateService');
const tenancy = require('../../services/creator/userTemplateTenancy');
const plan = require('../../services/creator/campaignPlanValidationService');
const cloneRoute = require('../../../pages/api/creator-templates/user/index').default;
/* eslint-enable @typescript-eslint/no-var-requires */

const CO_A = 'co-a-synthetic';
const CO_B = 'co-b-synthetic';
const sys = lib.listTemplatesForFamily('infographic')[0];
function rowFor(id: string, companyId: string): Row {
  const ut = cloneTemplate(sys, 'infographic', { id, ownerUserId: 'u-a' });
  return {
    id, company_id: companyId, owner_user_id: 'u-a', team_id: null, asset_family: 'infographic', name: `Template ${id}`,
    category: ut.category, description: '', status: 'published', version: 1, parent_template_id: sys.id, preview_url: null,
    template_json: JSON.parse(JSON.stringify(lib.serializeTemplate(ut))), updated_at: '', created_at: '',
  };
}
const payloadWith = (id: string) => ({ media_bundle: { metadata: { template_id: id, infographic_template_id: id, creator_card: { template_id: id } } } });

beforeEach(() => {
  lib.clearUserTemplateRegistry();
  for (const k of Object.keys(mockRows)) delete mockRows[k];
  mockQueries.length = 0;
  mockRows.creator_user_templates = [rowFor('ut-a', CO_A)];
  mockRows.creator_user_template_versions = [{ template_id: 'ut-a', version: 1, template_json: rowFor('ut-a', CO_A).template_json, created_at: '' }];
});
afterAll(() => lib.clearUserTemplateRegistry());

describe('userTemplateTenancy (pure)', () => {
  it('a user template is foreign to every company but its stamped owner; unstamped / no company = foreign; system never', () => {
    const own = tenancy.stampUserTemplateCompany(cloneTemplate(sys, 'infographic', { id: 'x', ownerUserId: 'u' }), CO_A);
    expect(own.ownership).toBe('user');
    expect(tenancy.isForeignUserTemplate(own, CO_A)).toBe(false);
    expect(tenancy.isForeignUserTemplate(own, CO_B)).toBe(true);
    expect(tenancy.isForeignUserTemplate(own, null)).toBe(true);
    const unstamped = cloneTemplate(sys, 'infographic', { id: 'y', ownerUserId: 'u' });
    expect(tenancy.isForeignUserTemplate(unstamped, CO_A)).toBe(true);
    expect(tenancy.isForeignUserTemplate(sys, CO_B)).toBe(false);
    expect(tenancy.isForeignUserTemplate(null, CO_B)).toBe(false);
  });
});

describe('render paths: B never resolves A\'s template', () => {
  it('ensureUserTemplateRegisteredForAsset for company B loads nothing for A\'s id (the read carries company_id)', async () => {
    await svc.ensureUserTemplateRegisteredForAsset(payloadWith('ut-a'), CO_B);
    expect(lib.getTemplateById('ut-a')).toBeNull();
    const reads = mockQueries.filter((q) => q.table === 'creator_user_templates');
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q.filters).toEqual(expect.arrayContaining([['company_id', CO_B]]));
  });

  it('CONTROL: for company A it loads, registers and stamps A', async () => {
    await svc.ensureUserTemplateRegisteredForAsset(payloadWith('ut-a'), CO_A);
    const t = lib.getTemplateById('ut-a');
    expect(t).not.toBeNull();
    expect(tenancy.userTemplateCompanyId(t)).toBe(CO_A);
  });

  it('THE CACHE LEAK: with A\'s template already registered in this process, B\'s render chokepoint clears every id field', async () => {
    await svc.ensureUserTemplateRegisteredForAsset(payloadWith('ut-a'), CO_A); // A's own render loaded it
    const bPayload = payloadWith('ut-a');
    await svc.ensureUserTemplateRegisteredForAsset(bPayload, CO_B); // returns without loading (foreign)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(tenancy.dropForeignUserTemplateRefs(bPayload, CO_B)).toEqual(['ut-a', 'ut-a', 'ut-a']);
      const md = bPayload.media_bundle.metadata as any;
      expect([md.template_id, md.infographic_template_id, md.creator_card.template_id]).toEqual([null, null, null]);
      expect(warn.mock.calls.map((c) => c[1]?.event)).toEqual(['creator_template_foreign_ref_dropped']);
    } finally {
      warn.mockRestore();
    }
  });

  it('CONTROLS: A\'s own ref, a system ref and an unknown ref are left alone; a render with NO company drops a user ref', () => {
    lib.registerUserTemplate(tenancy.stampUserTemplateCompany(cloneTemplate(sys, 'infographic', { id: 'ut-a', ownerUserId: 'u' }), CO_A));
    const own = payloadWith('ut-a');
    expect(tenancy.dropForeignUserTemplateRefs(own, CO_A)).toEqual([]);
    expect((own.media_bundle.metadata as any).template_id).toBe('ut-a');
    expect(tenancy.dropForeignUserTemplateRefs(payloadWith(sys.id), CO_B)).toEqual([]);
    expect(tenancy.dropForeignUserTemplateRefs(payloadWith('never-registered'), CO_B)).toEqual([]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(tenancy.dropForeignUserTemplateRefs(payloadWith('ut-a'), null).length).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('renderAsset runs the chokepoint before it renders anything (every render caller passes through it)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('fs').readFileSync(require('path').resolve(__dirname, '../../services/creatorAssetRendererRuntime.ts'), 'utf8');
    const entry = src.slice(src.indexOf('export async function renderAsset('));
    const drop = entry.indexOf('dropForeignUserTemplateRefs(assetPayload, options.companyId');
    expect(drop).toBeGreaterThan(0);
    expect(drop).toBeLessThan(entry.indexOf('runVisualFixLoop('));
  });

  it('loadAndRegisterUserTemplate(A\'s id, B) is null even when A\'s copy is registered', async () => {
    await svc.ensureUserTemplateRegisteredForAsset(payloadWith('ut-a'), CO_A);
    expect(await svc.loadAndRegisterUserTemplate('ut-a', CO_B)).toBeNull();
    expect((await svc.loadAndRegisterUserTemplate('ut-a', CO_A))?.id).toBe('ut-a'); // control
  });

  it('a pinned VERSION is loaded only after ownership is proven on the template row (B never reads A\'s versions)', async () => {
    expect(await svc.loadAndRegisterUserTemplateVersion('ut-a', 1, CO_B)).toBeNull();
    expect(mockQueries.filter((q) => q.table === 'creator_user_template_versions')).toEqual([]);
    const v = await svc.loadAndRegisterUserTemplateVersion('ut-a', 1, CO_A); // control
    expect(tenancy.userTemplateCompanyId(v)).toBe(CO_A);
  });
});

describe('plan validation and clone', () => {
  it('plan validation for B treats A\'s id as unresolved (graceful, nothing about A\'s template reported)', async () => {
    expect(await plan.resolvePlanTemplate('ut-a', CO_B)).toBeNull();
    const r = await plan.validatePlannedCard({ template_id: 'ut-a', slide_count: 99 }, 'infographic', CO_B);
    expect(r).toEqual({ ok: true, errors: [], descriptor: null });
    expect((await plan.resolvePlanTemplate('ut-a', CO_A))?.id).toBe('ut-a'); // control
  });

  it('clone: B cannot use A\'s template as source_template_id (no row inserted); A can; a system source works for anyone', async () => {
    const asB = (src: string) => svc.createUserTemplate({ companyId: CO_B, ownerUserId: 'u-b', family: 'infographic', sourceTemplateId: src });
    await expect(asB('ut-a')).rejects.toBeInstanceOf(tenancy.SourceTemplateNotFoundError);
    expect(mockQueries.filter((q) => q.table === 'creator_user_templates' && q.op === 'insert')).toEqual([]);
    // Even with A's copy already registered in this process:
    await svc.ensureUserTemplateRegisteredForAsset(payloadWith('ut-a'), CO_A);
    await expect(asB('ut-a')).rejects.toBeInstanceOf(tenancy.SourceTemplateNotFoundError);
    // An unknown id gets the SAME error (no existence signal; it used to clone a blank template silently):
    await expect(asB('ut-never-existed')).rejects.toBeInstanceOf(tenancy.SourceTemplateNotFoundError);
    expect(mockQueries.filter((q) => q.op === 'insert')).toEqual([]);
    // Controls:
    expect(await svc.createUserTemplate({ companyId: CO_A, ownerUserId: 'u-a', family: 'infographic', sourceTemplateId: 'ut-a' })).not.toBeNull();
    expect(await svc.createUserTemplate({ companyId: CO_B, ownerUserId: 'u-b', family: 'infographic', sourceTemplateId: sys.id })).not.toBeNull();
  });
});

describe('POST /api/creator-templates/user (clone)', () => {
  const post = async (source: string) => {
    const res: any = { statusCode: 0, body: null, setHeader: () => res };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await cloneRoute({ method: 'POST', query: {}, headers: {}, body: { company_id: CO_B, family: 'infographic', source_template_id: source } }, res);
    return res;
  };
  it("another company's template and an unknown id get the SAME 404; nothing is inserted", async () => {
    const foreign = await post('ut-a');
    const unknown = await post('ut-never-existed');
    expect([foreign.statusCode, foreign.body]).toEqual([404, { error: 'Source template not found' }]);
    expect([unknown.statusCode, unknown.body]).toEqual([foreign.statusCode, foreign.body]);
    expect(mockQueries.filter((q) => q.op === 'insert')).toEqual([]);
  });
  it('CONTROL: a system source clones (201)', async () => {
    expect((await post(sys.id)).statusCode).toBe(201);
  });
});
