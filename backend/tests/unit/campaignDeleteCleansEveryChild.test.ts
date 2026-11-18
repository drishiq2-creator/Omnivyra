/**
 * Campaign DELETE removes the campaign's rows from EVERY campaign-child table (coordinator ruling, 2026-11-18).
 *
 * Child rows of a deleted campaign used to survive (no FOREIGN KEY to campaigns; prod held 97 orphans), and an
 * orphan keeps the dead campaign's id. The expected table list is DERIVED from the generated registry
 * (backend/db/tenantTables.ts: every `parent: 'campaigns'` entry and every registry descendant of one), so a
 * future child table the delete does not clean fails here by NAME. The real route runs on the WS-D harness; every
 * table is seeded with a row for the deleted campaign AND a row for another campaign, and only the former may go.
 */
import { seed, invoke, rows, writeCalls, CO_A, USER_A } from '../helpers/routeAuthHarness';
import { as, roleRows } from '../helpers/sec91W2AHarness';
import { resetFaults } from '../helpers/wsdFaultClient';

jest.mock('@/config', () => ({ config: { DEV_USER_ID: '', NODE_ENV: 'production' } }));
jest.mock('../../db/supabaseClient', () => jest.requireActual('../helpers/wsdFaultClient').supabaseModule());
jest.mock('../../db/writeOwner', () => {
  const m = jest.requireActual('../helpers/routeAuthHarness').writeOwnerModule();
  const faulted = jest.requireActual('../helpers/wsdFaultClient').supabaseModule().supabase;
  return { ...m, ownedDbTable: (t: string) => (t === 'campaigns' ? faulted.from(t) : m.ownedDbTable(t)) };
});
jest.mock('../../services/supabaseAuthService', () => jest.requireActual('../helpers/sec91W2AHarness').authModule());
jest.mock('../../security/IdentityResolver', () => jest.requireActual('../helpers/sec91W2AHarness').identityModule());
jest.mock('../../services/authResolver', () => jest.requireActual('../helpers/sec91W2AHarness').authResolverModule());
jest.mock('../../../lib/platform/routeFactory', () => ({ createApiRoute: (h: unknown) => h }));
jest.mock('../../services/companyThemeStateService', () => ({ releaseThemeFromCampaign: jest.fn(async () => undefined) }));
jest.mock('../../services/campaignReadinessService', () => ({
  evaluateCampaignReadiness: jest.fn(async () => ({ readiness_state: 'ready', readiness_percentage: 100, blocking_issues: [] })),
}));

import { TENANT_CHILD_TABLES, TENANT_TABLES } from '../../db/tenantTables';
import {
  CAMPAIGN_CLEANUP_PLAN, FK_DELETE_BEFORE, cleanupPlanTables,
  type CampaignCleanupDescendant,
} from '../../services/campaignDeleteCleanup';
/* eslint-disable @typescript-eslint/no-var-requires */
const campaignById = require('../../../pages/api/campaigns/[id]').default;
/* eslint-enable @typescript-eslint/no-var-requires */

const X = 'camp-x-00-0000-0000-0000000000xx';
const OTHER = 'camp-o-00-0000-0000-0000000000oo';
type Row = Record<string, unknown>;
type Child = { via: string; parent: string; parentKey?: string };
const CHILDREN = TENANT_CHILD_TABLES as unknown as Record<string, Child>;
const DIRECT = TENANT_TABLES as unknown as Record<string, { column: string }>;

/** From the registry: every child of `campaigns`, and every registry descendant of one. */
function registryCampaignTree(): string[] {
  const out: string[] = [];
  let frontier = ['campaigns'];
  while (frontier.length) {
    const next = Object.keys(CHILDREN).filter((t) => frontier.includes(CHILDREN[t].parent) && !out.includes(t));
    out.push(...next);
    frontier = next;
  }
  return out;
}

/** The coordinator's minimum list (2026-11-18), by name. */
const COORDINATOR_MINIMUM = [
  'daily_content_plans', 'campaign_week_plan', 'campaign_planning_inputs', 'scheduled_posts',
  'campaign_activity_engagement_signals', 'performance_feedback', 'content_assets', 'content_asset_versions',
  'campaign_health_reports',
];

/** Seeds one row per plan table for `campaign` (and its descendants, linked by key); returns id per table. */
function seedCampaignRows(campaign: string, tag: string): Record<string, Row[]> {
  const tables: Record<string, Row[]> = {};
  const add = (t: string, r: Row) => { (tables[t] = tables[t] || []).push(r); };
  const descend = (parentTable: string, parent: Row, ds: CampaignCleanupDescendant[]) => {
    for (const d of ds) {
      const id = `${d.table}-${tag}-under-${parentTable}`;
      const row: Row = { id, asset_id: `${id}-key`, [d.via]: parent[d.parentKey] };
      add(d.table, row);
      descend(d.table, row, d.descendants);
    }
  };
  for (const step of CAMPAIGN_CLEANUP_PLAN) {
    const row: Row = { id: `${step.table}-${tag}`, asset_id: `${step.table}-${tag}-key`, [step.column]: campaign };
    if (step.column !== 'campaign_id') row.campaign_id = campaign;
    if (step.companyColumn) row[step.companyColumn] = CO_A;
    add(step.table, row);
    descend(step.table, row, step.descendants);
  }
  return tables;
}

function world(): void {
  const x = seedCampaignRows(X, 'x');
  const o = seedCampaignRows(OTHER, 'o');
  const extra: Record<string, Row[]> = {
    campaigns: [
      { id: X, company_id: CO_A, user_id: USER_A, name: 'X', status: 'planning' },
      { id: OTHER, company_id: CO_A, user_id: USER_A, name: 'Other', status: 'planning' },
    ],
    user_company_roles: roleRows(),
    campaign_versions: [
      { id: 'ver-x', campaign_id: X, company_id: CO_A, created_at: '2026-01-01T00:00:00Z', version: 1, campaign_snapshot: {} },
      { id: 'ver-other', campaign_id: OTHER, company_id: CO_A, created_at: '2026-01-01T00:00:00Z', version: 1, campaign_snapshot: {} },
    ],
  };
  for (const t of new Set([...Object.keys(x), ...Object.keys(o)])) extra[t] = [...(x[t] || []), ...(o[t] || [])];
  seed(extra);
}

const del = () => invoke(campaignById, { method: 'DELETE', query: { id: X }, body: {}, headers: as('A') });
/** Rows this suite seeded into `table` for the campaign tagged `tag` (directly, or under one of its rows). */
const seededIds = (table: string, tag: string) =>
  rows(table).map((r) => String(r.id)).filter((id) => id === `${table}-${tag}` || id.startsWith(`${table}-${tag}-under-`));

beforeEach(() => {
  resetFaults();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the cleanup plan is derived from the registry', () => {
  it('covers every registry child of campaigns and every registry descendant of one, by name', () => {
    const tree = registryCampaignTree();
    expect(tree.length).toBeGreaterThanOrEqual(41); // positive control: the registry walk found the children
    const missing = tree.filter((t) => !cleanupPlanTables().includes(t));
    expect(missing).toEqual([]);
  });

  it("covers the coordinator's minimum list, by name", () => {
    expect(COORDINATOR_MINIMUM.filter((t) => !cleanupPlanTables().includes(t))).toEqual([]);
  });

  it('registry children are keyed by their registry via column; direct tables by campaign_id + their tenant column', () => {
    for (const step of CAMPAIGN_CLEANUP_PLAN) {
      if (CHILDREN[step.table]?.parent === 'campaigns') {
        expect({ t: step.table, column: step.column, company: step.companyColumn })
          .toEqual({ t: step.table, column: CHILDREN[step.table].via, company: null });
      } else {
        expect({ t: step.table, column: step.column, company: step.companyColumn })
          .toEqual({ t: step.table, column: 'campaign_id', company: DIRECT[step.table]?.column ?? null });
      }
    }
  });

  it('every NO ACTION foreign-key pair is deleted referencing-table first', () => {
    const order = CAMPAIGN_CLEANUP_PLAN.map((s) => s.table);
    for (const [first, then] of FK_DELETE_BEFORE) {
      expect({ first, then, ok: order.indexOf(first) > -1 && order.indexOf(first) < order.indexOf(then) })
        .toEqual({ first, then, ok: true });
    }
  });
});

describe('DELETE /api/campaigns/:id', () => {
  it("removes the campaign's rows from every plan table and leaves another campaign's rows untouched", async () => {
    world();
    const tables = cleanupPlanTables();
    // Positive control: every plan table holds a row for X and one for OTHER before the delete.
    const before = Object.fromEntries(tables.map((t) => [t, seededIds(t, 'o').length]));
    for (const t of tables) expect({ t, x: seededIds(t, 'x').length > 0, o: before[t] > 0 }).toEqual({ t, x: true, o: true });

    const r = await del();
    expect(r.status).toBe(200);

    const survivingX = tables.filter((t) => seededIds(t, 'x').length > 0);
    const lostOther = tables.filter((t) => seededIds(t, 'o').length !== before[t]);
    expect({ survivingX, lostOther }).toEqual({ survivingX: [], lostOther: [] });
    expect(rows('campaigns').map((c) => c.id)).toContain(OTHER);
    expect(rows('campaigns').map((c) => c.id)).not.toContain(X);
  });

  it('every delete is keyed on the campaign (or a key of its own rows); direct tables also carry the owner', async () => {
    world();
    await del();
    for (const step of CAMPAIGN_CLEANUP_PLAN) {
      // A table that is also a registry descendant (bolt_content_jobs under bolt_execution_runs) is additionally
      // deleted by its parent key; the campaign-keyed deletes are the ones carrying the step column.
      const deletes = writeCalls([step.table]).filter((c) => c.op === 'delete' && step.column in (c.filters || {}));
      expect({ t: step.table, n: deletes.length > 0 }).toEqual({ t: step.table, n: true });
      for (const d of deletes) {
        const expected: Row = { [step.column]: X };
        if (step.companyColumn) expected[step.companyColumn] = CO_A;
        expect({ t: step.table, filters: d.filters }).toMatchObject({ t: step.table, filters: expected });
      }
    }
  });

  it('every campaign-child delete precedes the campaigns delete', async () => {
    world();
    await del();
    const deletes = writeCalls().filter((c) => c.op === 'delete').map((c) => c.table);
    const campaignsAt = deletes.indexOf('campaigns');
    expect(campaignsAt).toBeGreaterThan(-1);
    expect(cleanupPlanTables().filter((t) => !(deletes.indexOf(t) > -1 && deletes.indexOf(t) < campaignsAt))).toEqual([]);
  });
});
