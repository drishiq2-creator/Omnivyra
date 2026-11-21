/**
 * END TO END on the REAL schema (b3: the biggest unknown, first): one Sales Navigator page through the WHOLE server
 * chain the extension and Playwright use - no fakes between the loop and the database.
 *   the real gate (legal switch + both company flags + an acknowledgement row in consent_records)
 *   -> bindSalesNavMember (073 owner + binding) -> startSalesNavRun
 *   -> decideNextPage (074 consume, FOR SHARE, the pending mark)
 *   -> submitPage (fromWire -> the R3 screen -> ingestLeadBatch -> canonical leads + source records -> the record)
 *   -> a REPEATED page is refused before anything is ingested.
 *
 * The suite installs the shared pgRestTranslator for every PostgREST call, wrapped to add what PostgREST itself
 * returns and the store deliberately requires: a status code, `count: 'exact'` on update, and a set-returning RPC
 * answered as an ARRAY of rows (074's RETURNS TABLE). Other suites' translator behaviour is untouched.
 */
jest.mock('../../db/supabaseClient', () =>
  require('./pgRestTranslator').makeSupabaseModule(() => require('./setup').db, 'snE2E'));
jest.mock('../../db/writeOwner', () => {
  const sb = () => require('../../db/supabaseClient').supabase;
  const statusFor = (op: string, selected: boolean, error: unknown) =>
    (error ? 400 : op === 'insert' || op === 'upsert' ? 201 : op === 'select' ? 200 : selected ? 200 : 204);
  return {
    __esModule: true,
    ownedDbTable: (table: string) => {
      const inner = sb().from(table);
      let op = 'select'; let selected = false; let wantCount = false;
      const wrap: any = new Proxy(inner, {
        get(target: any, prop: string | symbol) {
          if (prop === 'then') {
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => target.then((r: any) => {
              const out: any = { ...r, status: statusFor(op, selected, r.error) };
              if (wantCount) { out.count = r.error ? null : (Array.isArray(r.data) ? r.data.length : 0); if (!selected) out.data = null; }
              return out;
            }).then(res, rej);
          }
          const v = target[prop];
          if (typeof v !== 'function') return v;
          return (...args: any[]) => {
            if (prop === 'update' || prop === 'delete') {
              op = String(prop);
              const opts = prop === 'update' ? args[1] : args[0];
              const r = target[prop](...(prop === 'update' ? [args[0]] : []));
              if (opts && opts.count === 'exact') { wantCount = true; r.select('id'); }
              return wrap;
            }
            if (prop === 'insert' || prop === 'upsert') op = String(prop);
            if (prop === 'select' && op !== 'select') selected = true;
            target[prop](...args);
            return wrap;
          };
        },
      });
      return wrap;
    },
    ownedDbRpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'salesnav_consume_daily_quota') {
        const { db } = require('./setup');
        const keys = Object.keys(args);
        await db.query('SAVEPOINT snE2E_rpc');
        try {
          const r = await db.query(`SELECT * FROM public.salesnav_consume_daily_quota(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, keys.map((k) => args[k]));
          await db.query('RELEASE SAVEPOINT snE2E_rpc');
          return { data: r.rows, error: null, status: 200 };
        } catch (e: any) {
          await db.query('ROLLBACK TO SAVEPOINT snE2E_rpc');
          return { data: null, error: { code: e?.code, message: e?.message }, status: 400 };
        }
      }
      const r = await sb().rpc(fn, args);
      return { ...r, status: r.error ? 400 : 200 };
    },
  };
});
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: jest.fn() }));
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: jest.fn(async (url: string) => { throw new Error(`unexpected egress from Sales Navigator ingestion: ${url}`); }),
}));

import { db, inRollback } from './setup';

/* eslint-disable @typescript-eslint/no-var-requires */
const { registerBuiltInLeadSources } = require('../../services/leadIngestion');
const { LEAD_INGESTION_FLAG_KEY } = require('../../services/leadIngestion/orchestrator');
const { upsertFeatureFlag } = require('../../services/featureFlagService');
const { bindSalesNavMember, startSalesNavRun, loadRun } = require('../../services/salesNav/store');
const { decideNextPage, submitPage } = require('../../services/salesNav/loop');
const { recordSalesNavAck, SALESNAV_RESTRICTION_ACK } = require('../../services/salesNav/restrictionAck');
const { SALESNAV_EXTRACTION_FLAG, salesNavTransportFlag } = require('../../services/salesNav/gate');
/* eslint-enable @typescript-eslint/no-var-requires */

const DB_URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(DB_URL)) {
  throw new Error(`salesnav_page_end_to_end refuses a non-loopback W6_DB_URL: ${DB_URL.replace(/:[^:@]+@/, ':***@')}`);
}

const ORG = '5a1e5a1e-0000-4000-8000-0000000000e1';
const USER = '5a1e5a1e-0000-4000-8000-0000000000e2';
const MEMBER = 'ACoAAAsnE2Etest00001';
const URN = `urn:li:fsd_profile:${MEMBER}`;
const LIST = 'https://www.linkedin.com/sales/lists/people/987654';
const ctx = { organizationId: ORG, initiatedBy: USER };
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const LEADS = [
  { lead_key: 'ACwAAAe2eLead001', full_name: 'Ada Lovelace', title: 'Head of Analytics', company_name: 'Engine Co',
    account_external_id: 'urn:li:fs_salesCompany:4242', public_profile_url: 'https://www.linkedin.com/in/ada-e2e/' },
  { lead_key: 'ACwAAAe2eLead002', full_name: 'Charles Babbage', title: 'Founder', company_name: 'Engine Co',
    account_external_id: 'urn:li:fs_salesCompany:4242' },
  { lead_key: 'ACwAAAe2eLead003', full_name: 'Mary Somerville', title: 'Researcher',
    public_profile_url: 'https://www.linkedin.com/sales/lead/X,NAME_SEARCH,secretAuthToken' },
];

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['ENABLE_LEAD_INGESTION', 'SALESNAV_EXTENSION_LEGAL_CLEARED']) saved[k] = process.env[k];
  process.env.ENABLE_LEAD_INGESTION = 'true';            // THIS PROCESS ONLY
  process.env.SALESNAV_EXTENSION_LEGAL_CLEARED = 'true'; // THIS PROCESS ONLY
  registerBuiltInLeadSources();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function enableEverything() {
  await q(`INSERT INTO public.companies (id, name) VALUES ($1, 'SalesNav E2E') ON CONFLICT (id) DO NOTHING`, [ORG]);
  // consent_records.granted_by REFERENCES users(id): the acknowledging user must exist (found by this suite's first run)
  await q(`INSERT INTO public.users (id, email) VALUES ($1, 'salesnav-e2e@example.test') ON CONFLICT (id) DO NOTHING`, [USER]);
  for (const flagKey of [LEAD_INGESTION_FLAG_KEY, SALESNAV_EXTRACTION_FLAG, salesNavTransportFlag('extension')]) {
    await upsertFeatureFlag({ organizationId: ORG, flagKey, enabled: true, rationale: 'salesnav e2e throwaway DB', createdBy: null });
  }
  await recordSalesNavAck(ctx, {
    transport: 'extension', shownVersion: SALESNAV_RESTRICTION_ACK.version, shownTextSha256: SALESNAV_RESTRICTION_ACK.textSha256,
  });
}

describe('Sales Navigator, one page end to end on the real schema', () => {
  it('bind -> start -> next (real 074 consume) -> submit -> canonical leads; a repeated page ingests nothing', () => inRollback(async () => {
    await enableEverything();
    expect(await bindSalesNavMember(ctx, 'extension', URN)).toEqual({ bound: true });
    const started = await startSalesNavRun(ctx, { transport: 'extension', url: LIST });
    expect(started).toMatchObject({ kind: 'lead_list', canonicalUrl: LIST });
    const runId = started.runId as string;

    // page 0: the server decides, reserving cap through the REAL 074 function
    const d0 = await decideNextPage(ctx, runId, { route: 'extension', attestedMemberId: URN });
    expect(d0).toMatchObject({ kind: 'read', pageIndex: 0, pageUrl: LIST, maxLeads: 25 });
    expect((await q(`SELECT consumed FROM public.salesnav_daily_quota WHERE member_id = $1`, [MEMBER])).rows[0].consumed).toBe(25);

    const s0 = await submitPage(ctx, runId, {
      route: 'extension', pageIndex: 0, finalUrl: LIST, outcome: 'ok', hasNextPage: true, listTotal: 3,
      leads: LEADS, readerVersion: 'snr-1', attestedMemberId: URN,
    });
    expect(s0).toMatchObject({ kind: 'ok', body: { accepted: 3, quotaRefused: 0 } });
    const body = (s0 as { body: Record<string, number> }).body;
    // every accepted lead is accounted for - and on a failure the WHOLE body is printed, so the cause is named
    const accounted = body.created + body.updated + body.skippedDuplicates + body.heldForReview + body.probeUnknown + body.rejected;
    if (accounted !== 3) throw new Error(`page 0 leads not all accounted for: ${JSON.stringify(body)}`);
    // three new people -> three CREATED (an object match, so a failure prints the whole page result)
    expect({ created: body.created, updated: body.updated, skippedDuplicates: body.skippedDuplicates,
      heldForReview: body.heldForReview, probeUnknown: body.probeUnknown, rejected: body.rejected })
      .toEqual({ created: 3, updated: 0, skippedDuplicates: 0, heldForReview: 0, probeUnknown: 0, rejected: 0 });

    // the database: canonical leads under the Sales Navigator namespace, evidence linked to THIS run
    const persons = await q(
      `SELECT count(*)::int n FROM public.unified_persons WHERE company_id = $1 AND external_keys ? 'linkedin_sales_navigator'`, [ORG]);
    expect(persons.rows[0].n).toBeGreaterThanOrEqual(1);
    const evidence = await q(`SELECT count(*)::int n FROM public.source_records WHERE organization_id = $1 AND ingestion_run_id = $2`, [ORG, runId]);
    expect(evidence.rows[0].n).toBeGreaterThanOrEqual(1);
    const stored = await q(`SELECT raw_payload::text AS t FROM public.source_records WHERE organization_id = $1`, [ORG]);
    for (const r of stored.rows) expect(r.t).not.toContain('secretAuthToken');   // review NEW 1, on the real store

    const run = await loadRun(ORG, runId);
    expect(run).toMatchObject({ status: 'running', next_page_index: 1, pending_page_index: null, pending_granted: null, pages_read: 1 });

    // page 1: the SAME three leads again -> refused as a repeat BEFORE ingestion; the run ends unknown/page_repeated
    const before = (await q(`SELECT count(*)::int n FROM public.source_records WHERE organization_id = $1`, [ORG])).rows[0].n;
    const d1 = await decideNextPage(ctx, runId, { route: 'extension', attestedMemberId: URN });
    expect(d1).toMatchObject({ kind: 'read', pageIndex: 1 });
    const s1 = await submitPage(ctx, runId, {
      route: 'extension', pageIndex: 1, finalUrl: `${LIST}?page=2`, outcome: 'ok', hasNextPage: true, listTotal: 3,
      leads: LEADS, readerVersion: 'snr-1', attestedMemberId: URN,
    });
    expect(s1).toMatchObject({ kind: 'refusal', error: 'PAGE_REPEATED', extra: { closed: true } });
    expect((await q(`SELECT count(*)::int n FROM public.source_records WHERE organization_id = $1`, [ORG])).rows[0].n).toBe(before);
    expect(await loadRun(ORG, runId)).toMatchObject({ status: 'unknown', status_code: 'page_repeated' });
  }));

  it('control: with the company flag OFF the gate stops the run at the first page and nothing is consumed', () => inRollback(async () => {
    await enableEverything();
    await upsertFeatureFlag({ organizationId: ORG, flagKey: salesNavTransportFlag('extension'), enabled: false, rationale: 'off', createdBy: null });
    await bindSalesNavMember(ctx, 'extension', URN);
    const started = await startSalesNavRun(ctx, { transport: 'extension', url: LIST });
    const d = await decideNextPage(ctx, started.runId, { route: 'extension', attestedMemberId: URN });
    expect(d).toEqual({ kind: 'stop', status: 'refused', code: 'gate_closed' });
    expect((await q(`SELECT count(*)::int n FROM public.salesnav_daily_quota WHERE member_id = $1`, [MEMBER])).rows[0].n).toBe(0);
  }));
});
