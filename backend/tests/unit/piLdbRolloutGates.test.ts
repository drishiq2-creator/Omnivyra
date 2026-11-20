/**
 * PI-LDB rollout gates (c6 2026-11-20, b3 rulings 2 + the live-write hazard 7c's deploy-order point exposed).
 *
 * 1. Repository: before 20270211000003/0005 are applied, lead_intelligence has no `display` / `origin_*` columns,
 *    and this write serves EVERY live lead source. So the columns are written only with PI_LDB_SCHEMA_READY=true.
 * 2. The import wizard is default OFF: UI flag (page / link / menu) and the per-company server gate.
 */
jest.mock('../../db/writeOwner', () => {
  const stores: Record<string, Array<Record<string, unknown>>> = { lead_intelligence: [], lead_intelligence_events: [] };
  const flags: { throw: boolean } = { throw: false };
  (globalThis as Record<string, unknown>).__liStores = stores;
  (globalThis as Record<string, unknown>).__liFlags = flags;

  function makeQuery(table: string) {
    if (flags.throw) throw new Error('db unavailable');
    const state: { filters: Array<[string, unknown]>; limitN?: number; upsertId?: string } = { filters: [] };
    const arr = () => (stores[table] ||= []);
    const builder: Record<string, unknown> = {
      upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
        const keys = (opts?.onConflict ?? '').split(',').filter(Boolean);
        const list = arr();
        const idx = keys.length ? list.findIndex((r) => keys.every((k) => r[k] === row[k])) : -1;
        let id: string;
        if (idx >= 0) { id = String(list[idx].id); list[idx] = { ...list[idx], ...row }; }
        else { id = `id_${list.length + 1}`; list.push({ id, ...row }); }
        state.upsertId = id;
        return builder;
      },
      insert(row: Record<string, unknown>) { const list = arr(); list.push({ id: `id_${list.length + 1}`, ...row }); return Promise.resolve({ data: null, error: null }); },
      select() { return builder; },
      eq(c: string, v: unknown) { state.filters.push([c, v]); return builder; },
      order() { return builder; },
      limit(n: number) { state.limitN = n; return builder; },
      maybeSingle() {
        if (state.upsertId) return Promise.resolve({ data: { id: state.upsertId }, error: null });
        const r = arr().find((rr) => state.filters.every(([c, v]) => rr[c] === v));
        return Promise.resolve({ data: r ?? null, error: null });
      },
      then(resolve: (x: { data: unknown; error: null }) => void) {
        let r = arr().filter((rr) => state.filters.every(([c, v]) => rr[c] === v));
        if (state.limitN != null) r = r.slice(0, state.limitN);
        resolve({ data: r, error: null });
      },
    };
    return builder;
  }
  return { ownedDbTable: (t: string) => makeQuery(t) };
});

import { upsertCanonicalLead, appendLeadEvent, getCanonicalLead, listCanonicalLeads, getLeadTimeline } from '../../services/leadIntelligence/leadIntelligenceRepository';
import type { CanonicalLead } from '../../../lib/leadIntelligence';

const stores = (globalThis as Record<string, unknown>).__liStores as Record<string, Array<Record<string, unknown>>>;
const flags = (globalThis as Record<string, unknown>).__liFlags as { throw: boolean };

const lead = (over: Partial<CanonicalLead> = {}): CanonicalLead => ({
  organizationId: 'co1', source: 'website', unifiedPersonId: 'up1', ingestedAt: '2026-01-01T00:00:00Z',
  identity: { email: 'a@b.com', unifiedPersonId: 'up1' },
  attribution: { originalSource: 'web', originalChannel: null, campaign: 'q3', content: null, session: null, journey: null, referrer: null, utm: { source: null, medium: null, campaign: null, content: null, term: null }, identity: {}, sourceMetadata: {} },
  scores: { total: 0.7 }, status: 'new', occurredAt: '2026-01-01T00:00:00Z',
  sourceRef: { table: 'leads', id: 'l1' },
  ...over,
});

beforeEach(() => { stores.lead_intelligence.length = 0; stores.lead_intelligence_events.length = 0; flags.throw = false; });

import { isPiLdbSchemaReady } from '../../services/leadIntelligence/piLdbSchemaReady';
import { resolveProspectImportGate, PROSPECT_IMPORT_FLAG_KEY } from '../../services/leadIngestion/prospectImportGate';
import { isProspectImportUiEnabled } from '../../../lib/prospects/import/prospectImportUi';

beforeEach(() => { stores.lead_intelligence.length = 0; flags.throw = false; delete process.env.PI_LDB_SCHEMA_READY; });
afterAll(() => { delete process.env.PI_LDB_SCHEMA_READY; });

const PI_LDB_COLUMNS = ['display', 'origin_category', 'origin_observed_at'];

describe('repository: the PI-LDB columns are written only once the schema is applied', () => {
  it('DEFAULT (switch unset): the write carries NONE of the 3 new columns (the column set main writes)', async () => {
    expect(isPiLdbSchemaReady()).toBe(false);
    await upsertCanonicalLead(lead());
    expect(stores.lead_intelligence).toHaveLength(1);
    for (const c of PI_LDB_COLUMNS) expect(Object.keys(stores.lead_intelligence[0])).not.toContain(c);
  });

  it('control: PI_LDB_SCHEMA_READY=true -> all 3 keys are ALWAYS present (null when unknown)', async () => {
    process.env.PI_LDB_SCHEMA_READY = 'true';
    await upsertCanonicalLead(lead());
    for (const c of PI_LDB_COLUMNS) expect(Object.keys(stores.lead_intelligence[0])).toContain(c);
  });

  it('STRICT: only the exact string "true" opens it (ON is the dangerous state)', () => {
    for (const v of ['1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ', '']) {
      expect(isPiLdbSchemaReady({ PI_LDB_SCHEMA_READY: v } as never)).toBe(false);
    }
    expect(isPiLdbSchemaReady({ PI_LDB_SCHEMA_READY: 'true' } as never)).toBe(true);
  });
});

jest.mock('../../../components/prospects/import/ImportWizard', () => ({ __esModule: true, default: () => null }));
jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: null }) }));

describe('import wizard UI flag: default OFF', () => {
  it('DEFAULT: the /prospects/import page is notFound; control: with the flag on it renders', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getServerSideProps } = require('../../../pages/prospects/import');
    delete process.env.NEXT_PUBLIC_PROSPECT_IMPORT_ENABLED;
    expect(await getServerSideProps({} as never)).toEqual({ notFound: true });
    process.env.NEXT_PUBLIC_PROSPECT_IMPORT_ENABLED = 'true';
    try {
      expect(await getServerSideProps({} as never)).toEqual({ props: {} });
    } finally {
      delete process.env.NEXT_PUBLIC_PROSPECT_IMPORT_ENABLED;
    }
  });

  it('unset -> hidden; only "true" shows it', () => {
    expect(isProspectImportUiEnabled(undefined)).toBe(false);
    for (const v of ['1', 'TRUE', 'True', ' true']) expect(isProspectImportUiEnabled(v)).toBe(false);
    expect(isProspectImportUiEnabled('true')).toBe(true);
  });
});

describe('import wizard server gate: every condition required, fails closed', () => {
  const open = {
    ingestionGate: async () => ({ allowed: true, reason: 'tenant_flag:on' }),
    schemaReady: () => true,
    evaluate: jest.fn(async () => ({ enabled: true, reason: 'on' })),
  };
  beforeEach(() => { open.evaluate.mockClear(); });

  it('control: all open -> allowed, asking the tenant own prospect_import flag', async () => {
    const d = await resolveProspectImportGate('org-1', open);
    expect(d.allowed).toBe(true);
    expect(open.evaluate).toHaveBeenCalledWith({ organizationId: 'org-1', flagKey: PROSPECT_IMPORT_FLAG_KEY, cohortKey: null });
    expect(PROSPECT_IMPORT_FLAG_KEY).toBe('prospect_import');
  });
  it('ingestion gate closed -> refused', async () => {
    const d = await resolveProspectImportGate('org-1', { ...open, ingestionGate: async () => ({ allowed: false, reason: 'global_kill_switch_off' }) });
    expect(d).toEqual({ allowed: false, reason: 'ingestion:global_kill_switch_off' });
  });
  it('schema not applied -> refused, and the tenant flag is not even read', async () => {
    const d = await resolveProspectImportGate('org-1', { ...open, schemaReady: () => false });
    expect(d).toEqual({ allowed: false, reason: 'schema_not_ready' });
    expect(open.evaluate).not.toHaveBeenCalled();
  });
  it('DEFAULT: no prospect_import row for the tenant -> refused', async () => {
    const d = await resolveProspectImportGate('org-1', { ...open, evaluate: async () => ({ enabled: false, reason: 'flag_not_found' }) });
    expect(d.allowed).toBe(false);
  });
  it('a THROWN flag lookup -> refused (never open on error)', async () => {
    const d = await resolveProspectImportGate('org-1', { ...open, evaluate: async () => { throw new Error('db down'); } });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/^flag_evaluation_failed:/);
  });
  it('DEFAULT environment end to end: with nothing set, the real gate refuses', async () => {
    const d = await resolveProspectImportGate('org-1');
    expect(d.allowed).toBe(false);
  });
});
