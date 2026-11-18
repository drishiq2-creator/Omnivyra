/**
 * Campaign DELETE cleanup plan (coordinator ruling, 2026-11-18).
 *
 * Child rows of a deleted campaign used to survive (no FOREIGN KEY to campaigns on most of them; prod held 97
 * orphans), and an orphan keeps the dead campaign's id, so whoever holds that id can reach it. The DELETE route
 * (pages/api/campaigns/[id].ts) therefore removes the campaign's rows from EVERY campaign-child table before the
 * campaigns row.
 *
 * The list is DERIVED from the generated registry (backend/db/tenantTables.ts), never kept by hand:
 *   - every TENANT_CHILD_TABLES entry with `parent: 'campaigns'`, keyed by its `via` column;
 *   - below each deleted table, every registry child of THAT table (e.g. content_asset_versions via asset_id under
 *     content_assets), recursively, deleted BEFORE its parent by the parent's key;
 *   - plus CAMPAIGN_KEYED_DIRECT_TABLES: tables the registry records as DIRECT tenancy (or under another parent)
 *     that also carry `campaign_id`. The registry does not record that column for them, so they are NAMED here;
 *     a direct table is additionally filtered by its registry tenant column = the campaign's owner.
 *
 * Only rows matching the campaign id are touched (`.eq(via, id)`), so structural NULLs are never swept up.
 * Order: FK_DELETE_BEFORE pairs (NO ACTION foreign keys between these tables, supabase/_schema/baseline.sql) put
 * the referencing table first; otherwise registry order, then the named direct tables.
 */
import { TENANT_CHILD_TABLES, TENANT_TABLES } from '../db/tenantTables';

/** Tables that carry campaign_id but are not registry children of `campaigns`. Existing 3AH-116 entries first. */
export const CAMPAIGN_KEYED_DIRECT_TABLES: readonly string[] = [
  'bolt_content_jobs', // child of bolt_execution_runs in the registry; carries campaign_id
  'bolt_execution_runs',
  'campaign_metrics',
  'campaign_analytics', // not in the registry
  'campaign_planning_inputs',
  'campaign_activity_engagement_signals',
  'campaign_health_reports',
  'performance_feedback', // child of recommendation_snapshots in the registry; carries campaign_id
];

/**
 * [referencing, referenced]: NO ACTION foreign keys between tables in this plan (baseline.sql):
 * platform_content_slots.{daily_plan_id,scheduled_post_id,bolt_job_id}, ai_enhancement_logs.day_id,
 * daily_content_plans.source_refinement_id.
 */
export const FK_DELETE_BEFORE: ReadonlyArray<readonly [string, string]> = [
  ['platform_content_slots', 'daily_content_plans'],
  ['platform_content_slots', 'scheduled_posts'],
  ['platform_content_slots', 'bolt_content_jobs'],
  ['ai_enhancement_logs', 'daily_content_plans'],
  ['daily_content_plans', 'weekly_content_refinements'],
];

export type CampaignCleanupDescendant = {
  table: string;
  /** Column on `table` holding the parent's key. */
  via: string;
  /** Key column on the parent. */
  parentKey: string;
  descendants: CampaignCleanupDescendant[];
};

export type CampaignCleanupStep = {
  table: string;
  /** Column holding the campaign id. */
  column: string;
  /** Registry tenant column (direct tables only), filtered to the campaign's owner. */
  companyColumn: string | null;
  descendants: CampaignCleanupDescendant[];
};

type ChildEntry = { via: string; parent: string; parentKey?: string };
const CHILDREN = TENANT_CHILD_TABLES as unknown as Record<string, ChildEntry>;
const DIRECT = TENANT_TABLES as unknown as Record<string, { column: string }>;

function descendantsOf(table: string, depth = 0): CampaignCleanupDescendant[] {
  if (depth > 6) throw new Error(`campaignDeleteCleanup: registry parent chain under ${table} is too deep (cycle?)`);
  return Object.keys(CHILDREN)
    .filter((t) => CHILDREN[t].parent === table)
    .map((t) => ({
      table: t,
      via: CHILDREN[t].via,
      parentKey: CHILDREN[t].parentKey ?? 'id',
      descendants: descendantsOf(t, depth + 1),
    }));
}

/** Registry children of `campaigns`, by name, in registry order. */
export function registryCampaignChildTables(): string[] {
  return Object.keys(CHILDREN).filter((t) => CHILDREN[t].parent === 'campaigns');
}

function orderSteps(steps: CampaignCleanupStep[]): CampaignCleanupStep[] {
  const out: CampaignCleanupStep[] = [];
  const pending = [...steps];
  while (pending.length) {
    // First pending step that no other pending step must precede.
    const i = pending.findIndex((s) => !FK_DELETE_BEFORE.some(([a, b]) => b === s.table && pending.some((p) => p.table === a)));
    if (i < 0) throw new Error('campaignDeleteCleanup: FK_DELETE_BEFORE has a cycle');
    out.push(pending.splice(i, 1)[0]);
  }
  return out;
}

export function buildCampaignCleanupPlan(): CampaignCleanupStep[] {
  const registry = registryCampaignChildTables();
  const steps: CampaignCleanupStep[] = registry.map((t) => ({
    table: t,
    column: CHILDREN[t].via,
    companyColumn: null,
    descendants: descendantsOf(t),
  }));
  for (const t of CAMPAIGN_KEYED_DIRECT_TABLES) {
    if (registry.includes(t)) continue;
    steps.push({ table: t, column: 'campaign_id', companyColumn: DIRECT[t]?.column ?? null, descendants: descendantsOf(t) });
  }
  return orderSteps(steps);
}

export const CAMPAIGN_CLEANUP_PLAN: readonly CampaignCleanupStep[] = buildCampaignCleanupPlan();

/** Every table the plan deletes from (steps and their descendants). */
export function cleanupPlanTables(plan: readonly CampaignCleanupStep[] = CAMPAIGN_CLEANUP_PLAN): string[] {
  const names = new Set<string>();
  const walk = (ds: CampaignCleanupDescendant[]) => ds.forEach((d) => { names.add(d.table); walk(d.descendants); });
  for (const s of plan) { names.add(s.table); walk(s.descendants); }
  return Array.from(names);
}

/** PostgREST / Postgres "relation does not exist" — a table absent from this deployment. */
export const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

export type CleanupFailure = { table: string; code: string | null };

type Db = { from(table: string): any };

const PAGE = 1000;
const IN_CHUNK = 100;

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

const isMissing = (error: { code?: unknown } | null | undefined) => !!error && MISSING_TABLE_CODES.has(String(error.code));

/** Deletes rows of `table` where `column` is one of `values` (+ company filter), descendants first. */
async function purge(
  db: Db,
  table: string,
  column: string,
  values: string[],
  company: { column: string; value: string } | null,
  descendants: CampaignCleanupDescendant[],
): Promise<CleanupFailure | null> {
  const scope = (q: any, chunk: string[]) => {
    let s = chunk.length === 1 ? q.eq(column, chunk[0]) : q.in(column, chunk);
    if (company) s = s.eq(company.column, company.value);
    return s;
  };
  for (const d of descendants) {
    for (const chunk of chunks(values, IN_CHUNK)) {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await scope(db.from(table).select(d.parentKey), chunk)
          .order(d.parentKey, { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) {
          if (isMissing(error)) break;
          return { table, code: error.code ?? null };
        }
        const page = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
        const keys = page.map((r) => r[d.parentKey]).filter((k): k is string => typeof k === 'string' && k !== '');
        if (keys.length) {
          const failed = await purge(db, d.table, d.via, keys, null, d.descendants);
          if (failed) return failed;
        }
        if (page.length < PAGE) break;
      }
    }
  }
  for (const chunk of chunks(values, IN_CHUNK)) {
    const { error } = await scope(db.from(table).delete(), chunk);
    if (error && !isMissing(error)) return { table, code: error.code ?? null };
  }
  return null;
}

/**
 * Removes the campaign's rows from every table in the plan, in order. Stops at the FIRST failure and returns it
 * (nothing later, in particular the campaigns row, is touched); a table missing from the deployment is skipped.
 */
export async function purgeCampaignChildren(
  db: Db,
  campaignId: string,
  ownerCompanyId: string,
  plan: readonly CampaignCleanupStep[] = CAMPAIGN_CLEANUP_PLAN,
): Promise<CleanupFailure | null> {
  for (const step of plan) {
    const company = step.companyColumn ? { column: step.companyColumn, value: ownerCompanyId } : null;
    const failed = await purge(db, step.table, step.column, [campaignId], company, step.descendants);
    if (failed) return failed;
  }
  return null;
}
