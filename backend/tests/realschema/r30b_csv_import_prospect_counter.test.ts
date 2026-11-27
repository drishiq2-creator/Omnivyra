/**
 * Round 30B (owner decision 7) — the CSV import path and its prospect counter on REAL PostgreSQL.
 *
 * Drives what `/api/lead-ingestion/csv` does after authorization: the REAL per-company gate
 * (`resolveProspectImportGate`: lead_ingestion + PI-LDB schema switch + the tenant's `prospect_import` flag, written
 * and read through the production featureFlagService) and `ingestLeadBatch({ source: CSV_SOURCE })`. The count is
 * the production `tallyProspectOutcomes`, and every count is checked against the persisted `canonical_leads` rows.
 *
 * Covered: insertion, updates, unchanged rows, rejected rows, deduplication (in-batch and on replay), partial failure
 * (a bad row beside good ones), tenant isolation, and the gate's enabled / disabled / missing / cross-tenant states.
 *
 * STUBBED, EXACTLY as as1_csv_ingestion_canonical: the DB transport (pgRestTranslator), telemetry, and safeFetch
 * (this path must never reach the network). Every test runs in `inRollback`. A green run is evidence about a
 * disposable database built from the committed baseline plus replayed migrations - NOT about production.
 */
jest.mock('../../db/supabaseClient', () =>
  require('./pgRestTranslator').makeSupabaseModule(() => require('./setup').db, 'r30b'));
jest.mock('../../db/writeOwner', () => ({
  __esModule: true,
  ownedDbTable: (table: string) => require('../../db/supabaseClient').supabase.from(table),
  ownedDbRpc: (fn: string, args: Record<string, unknown>) => require('../../db/supabaseClient').supabase.rpc(fn, args),
}));
jest.mock('../../services/telemetry/telemetryDispatcher', () => ({ trackEvent: jest.fn() }));
jest.mock('../../../lib/security/safeFetch', () => ({
  safeFetch: jest.fn(async (url: string) => { throw new Error(`unexpected egress from CSV ingestion: ${url}`); }),
}));

import { db, inRollback } from './setup';

/* eslint-disable @typescript-eslint/no-var-requires */
const { registerBuiltInLeadSources } = require('../../services/leadIngestion');
const { ingestLeadBatch, LEAD_INGESTION_FLAG_KEY } = require('../../services/leadIngestion/orchestrator');
const { resolveProspectImportGate, PROSPECT_IMPORT_FLAG_KEY } = require('../../services/leadIngestion/prospectImportGate');
const { CSV_SOURCE } = require('../../services/leadIngestion/adapters/csvAdapter');
const { upsertFeatureFlag } = require('../../services/featureFlagService');
const { tallyProspectOutcomes } = require('../../../lib/prospects/prospectOutcomeTally');
/* eslint-enable @typescript-eslint/no-var-requires */

const DB_URL = process.env.W6_DB_URL ?? '';
if (!/@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(DB_URL)) {
  throw new Error(`r30b_csv_import_prospect_counter refuses a non-loopback W6_DB_URL: ${DB_URL.replace(/:[^:@]+@/, ':***@')}`);
}

/** Synthetic tenants for a disposable DB. Never production identifiers. */
const ORG_A = '30b0c5a0-0000-4000-8000-0000000000a1';
const ORG_B = '30b0c5a0-0000-4000-8000-0000000000b2';
const AT = '2026-11-27T09:00:00.000Z';
const RUN = '30b0c5a0-0000-4000-8000-00000000c001';

const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const prospects = async (org: string): Promise<number> =>
  (await q('SELECT count(*)::int n FROM public.canonical_leads WHERE company_id = $1', [org])).rows[0].n;

async function seedTenant(org: string, name: string) {
  await q('INSERT INTO public.companies (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [org, name]);
}
async function flag(org: string, flagKey: string, enabled: boolean) {
  await upsertFeatureFlag({ organizationId: org, flagKey, enabled, rationale: 'r30b real-schema throwaway DB', createdBy: null });
}
async function openTenant(org: string, name: string) {
  await seedTenant(org, name);
  await flag(org, LEAD_INGESTION_FLAG_KEY, true);
  await flag(org, PROSPECT_IMPORT_FLAG_KEY, true);
}

/** Exactly what the route does after authorization: the gate, then the batch. */
async function routeImport(org: string, records: Array<Record<string, unknown>>) {
  const gate = await resolveProspectImportGate(org);
  if (!gate.allowed) return { gate, result: null as any, tally: null as any };
  const result = await ingestLeadBatch({ organizationId: org, source: CSV_SOURCE, records, ingestionRunId: RUN, now: AT });
  return { gate, result, tally: tallyProspectOutcomes(result.outcomes) };
}

const row = (ref: string, over: Record<string, unknown> = {}) => ({
  referenceId: `r30b-${ref}`, email: `${ref}@r30b-co.test`, fullName: `Person ${ref}`, jobTitle: 'Analyst', ...over,
});
const NO_IDENTITY = { fullName: 'Nobody Atall', jobTitle: 'Ghost' };

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['ENABLE_LEAD_INGESTION', 'PI_LDB_SCHEMA_READY']) saved[k] = process.env[k];
  process.env.ENABLE_LEAD_INGESTION = 'true';   // THIS PROCESS ONLY
  registerBuiltInLeadSources();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
// The PI-LDB schema switch is opened ONLY around the gate read (it also changes which lead_intelligence columns the
// projection writes); ingestion below runs with the repository's default column set, exactly as as1 does.
async function gateWithSchemaReady(org: string) {
  const prev = process.env.PI_LDB_SCHEMA_READY;
  process.env.PI_LDB_SCHEMA_READY = 'true';
  try { return await resolveProspectImportGate(org); } finally {
    if (prev === undefined) delete process.env.PI_LDB_SCHEMA_READY; else process.env.PI_LDB_SCHEMA_READY = prev;
  }
}

describe('the per-company prospect_import gate, on the real flag store', () => {
  it('missing flag row -> closed; disabled -> closed; enabled -> open; another tenant stays closed', async () => {
    await inRollback(async () => {
      await seedTenant(ORG_A, 'R30B A');
      await seedTenant(ORG_B, 'R30B B');
      await flag(ORG_A, LEAD_INGESTION_FLAG_KEY, true);
      await flag(ORG_B, LEAD_INGESTION_FLAG_KEY, true);

      expect(await gateWithSchemaReady(ORG_A)).toMatchObject({ allowed: false, reason: 'tenant_flag:no_flag_row' });
      await flag(ORG_A, PROSPECT_IMPORT_FLAG_KEY, false);
      expect(await gateWithSchemaReady(ORG_A)).toMatchObject({ allowed: false, reason: 'tenant_flag:flag_disabled' });
      await flag(ORG_A, PROSPECT_IMPORT_FLAG_KEY, true);
      expect(await gateWithSchemaReady(ORG_A)).toMatchObject({ allowed: true });
      // tenant isolation: A's flag does not open B
      expect(await gateWithSchemaReady(ORG_B)).toMatchObject({ allowed: false, reason: 'tenant_flag:no_flag_row' });
      // the schema switch is part of the gate: unset -> closed even with the flag on
      delete process.env.PI_LDB_SCHEMA_READY;
      expect(await resolveProspectImportGate(ORG_A)).toMatchObject({ allowed: false, reason: 'schema_not_ready' });
    });
  });

  it('the lead_ingestion flag OFF closes the import gate even with prospect_import ON', async () => {
    await inRollback(async () => {
      await seedTenant(ORG_A, 'R30B A');
      await flag(ORG_A, PROSPECT_IMPORT_FLAG_KEY, true);
      const g = await gateWithSchemaReady(ORG_A);
      expect(g.allowed).toBe(false);
      expect(String(g.reason)).toMatch(/^ingestion:/);
    });
  });
});

describe('CSV import counts = persisted canonical prospects', () => {
  // The import itself runs with PI_LDB_SCHEMA_READY unset (the gate is proven above), so it uses routeImport's
  // ingestion half directly after asserting the gate opens.
  async function importOpen(org: string, records: Array<Record<string, unknown>>) {
    expect((await gateWithSchemaReady(org)).allowed).toBe(true);
    const result = await ingestLeadBatch({ organizationId: org, source: CSV_SOURCE, records, ingestionRunId: RUN, now: AT });
    return { result, tally: tallyProspectOutcomes(result.outcomes) };
  }

  it('insert: three new people -> 3 new prospects, and exactly 3 canonical_leads rows were written', async () => {
    await inRollback(async () => {
      await openTenant(ORG_A, 'R30B A');
      const before = await prospects(ORG_A);
      const { result, tally } = await importOpen(ORG_A, [row('a'), row('b'), row('c')]);
      expect(result.succeeded).toBe(3);
      expect(tally).toMatchObject({ newProspects: 3, updated: 0, unchanged: 0, rejected: 0, total: 3 });
      expect((await prospects(ORG_A)) - before).toBe(3);
      // the counted ids ARE the persisted rows, in this tenant
      const ids = result.outcomes.map((o: { prospectId: string }) => o.prospectId);
      const persisted = await q('SELECT count(*)::int n FROM public.canonical_leads WHERE company_id = $1 AND id = ANY($2::uuid[])', [ORG_A, ids]);
      expect(persisted.rows[0].n).toBe(3);
      for (const o of result.outcomes) expect(o.prospectOutcome).toBe('created');
    });
  });

  it('replay unchanged: the same rows again -> 0 new, 3 unchanged, no new canonical_leads', async () => {
    await inRollback(async () => {
      await openTenant(ORG_A, 'R30B A');
      await importOpen(ORG_A, [row('a'), row('b'), row('c')]);
      const mid = await prospects(ORG_A);
      const { result, tally } = await importOpen(ORG_A, [row('a'), row('b'), row('c')]);
      expect(tally).toMatchObject({ newProspects: 0, unchanged: 3, updated: 0, rejected: 0 });
      for (const o of result.outcomes) expect(o.prospectOutcome).toBe('matched');
      expect(await prospects(ORG_A)).toBe(mid);
    });
  });

  it('update: a changed attribute on an existing prospect -> 0 new, 1 updated, no new canonical_leads', async () => {
    await inRollback(async () => {
      await openTenant(ORG_A, 'R30B A');
      const first = await importOpen(ORG_A, [row('a')]);
      const mid = await prospects(ORG_A);
      const { result, tally } = await importOpen(ORG_A, [row('a', { jobTitle: 'Head of Analytics' })]);
      expect(tally).toMatchObject({ newProspects: 0, updated: 1, unchanged: 0 });
      expect(result.outcomes[0].prospectId).toBe(first.result.outcomes[0].prospectId);
      expect(result.outcomes[0].provenanceOutcome).not.toBe('unchanged');
      expect(await prospects(ORG_A)).toBe(mid);
    });
  });

  it('dedup in one file: the same person twice -> ONE new prospect, ONE canonical_leads row', async () => {
    await inRollback(async () => {
      await openTenant(ORG_A, 'R30B A');
      const before = await prospects(ORG_A);
      const { result, tally } = await importOpen(ORG_A, [row('d'), row('d')]);
      expect(result.outcomes[0].prospectId).toBe(result.outcomes[1].prospectId);
      expect(tally.newProspects).toBe(1);
      expect((await prospects(ORG_A)) - before).toBe(1);
    });
  });

  it('partial failure: a row with no identity beside good rows -> good rows land, the bad one is rejected, counts match', async () => {
    await inRollback(async () => {
      await openTenant(ORG_A, 'R30B A');
      const before = await prospects(ORG_A);
      const { result, tally } = await importOpen(ORG_A, [row('e'), NO_IDENTITY, row('f')]);
      expect(result.outcomes[1]).toMatchObject({ ok: false });
      expect(tally).toMatchObject({ newProspects: 2, rejected: 1, total: 3 });
      expect((await prospects(ORG_A)) - before).toBe(2);
    });
  });

  it('tenant isolation: the same rows into tenant B make B its own prospects and leave A unchanged', async () => {
    await inRollback(async () => {
      await openTenant(ORG_A, 'R30B A');
      await openTenant(ORG_B, 'R30B B');
      const a = await importOpen(ORG_A, [row('g'), row('h')]);
      const aCount = await prospects(ORG_A);
      const bBefore = await prospects(ORG_B);
      const b = await importOpen(ORG_B, [row('g'), row('h')]);
      expect(b.tally.newProspects).toBe(2);                         // B's own prospects, not A's matched
      expect((await prospects(ORG_B)) - bBefore).toBe(2);
      expect(await prospects(ORG_A)).toBe(aCount);
      const aIds = new Set(a.result.outcomes.map((o: { prospectId: string }) => o.prospectId));
      for (const o of b.result.outcomes) expect(aIds.has(o.prospectId)).toBe(false);
    });
  });

  it('a closed gate imports nothing (the route refuses before ingestLeadBatch)', async () => {
    await inRollback(async () => {
      await seedTenant(ORG_B, 'R30B B');
      await flag(ORG_B, LEAD_INGESTION_FLAG_KEY, true);             // prospect_import absent
      const before = await prospects(ORG_B);
      const out = await routeImport(ORG_B, [row('i')]);
      expect(out.gate.allowed).toBe(false);
      expect(out.result).toBeNull();
      expect(await prospects(ORG_B)).toBe(before);
    });
  });
});
