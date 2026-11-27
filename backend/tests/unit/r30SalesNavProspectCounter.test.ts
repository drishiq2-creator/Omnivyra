/**
 * Round 30 / P0-2 — the Sales Navigator page counter counts PROSPECTS, not evidence (decision pack row 17; X2).
 *
 * Through the real /next + /pages handlers and the real loop, over the shared fake 073 store. Only the screen and the
 * orchestrator are doubled, and the double returns the orchestrator's real outcome shape. The batch below is the case
 * the old counter got wrong: a NEW evidence row for a person who is ALREADY a prospect (provenance 'created',
 * prospect 'matched') was counted as a new lead.
 */
import { nextHandler, pagesHandler, type SalesNavExtensionDeps } from '../../apiHandlers/salesNav/extensionRoutes';
import { bindSalesNavMember, startSalesNavRun } from '../../services/salesNav/store';
import { fakeDb } from '../helpers/salesNavFakeDb';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const USER = 'user-a';
const M1 = 'ACoAAAcountTest00001';
const URN = `urn:li:fsd_profile:${M1}`;
const LIST = 'https://www.linkedin.com/sales/lists/people/123';
const NOW = new Date('2026-11-27T12:00:00Z');

function call(body: unknown, query: Record<string, string> = {}) {
  const res: any = { _status: 0, _json: undefined as any };
  res.status = (c: number) => { res._status = c; return res; };
  res.json = (b: unknown) => { res._json = b; return res; };
  res.setHeader = () => undefined;
  return { req: { method: 'POST', query, body } as any, res };
}

type Outcome = Record<string, unknown>;
async function pageWith(outcomes: (records: any[]) => Outcome[], leads: string[], org = ORG) {
  const db = fakeDb();
  const st = { table: db.table, now: () => NOW };
  await bindSalesNavMember({ organizationId: org, initiatedBy: USER }, 'extension', M1, st);
  const r = await startSalesNavRun({ organizationId: org, initiatedBy: USER }, { transport: 'extension', url: LIST }, st);
  if (!('runId' in r)) throw new Error('no run');
  const ingest = jest.fn(async ({ records }: any) => ({
    organizationId: org, source: 's', total: records.length, succeeded: records.length, failed: 0, outcomes: outcomes(records),
  }));
  const deps: SalesNavExtensionDeps = {
    auth: async () => ({ session: { userId: USER, orgId: org, expiresAt: 9e12, hmacNonce: 'n' } }),
    gate: async () => ({ allowed: true, reason: 'cleared' }),
    legalCleared: () => true,
    store: { table: db.table, rpc: (async (_f: string, a: any) => ({ data: [{ granted: a.p_count, consumed: a.p_count, remaining: 100 }], error: null, status: 200 })) as never, now: () => NOW },
    screen: (async ({ records }: any) => ({ toIngest: records, skippedDuplicates: 0, heldForReview: 0, probeUnknown: 0 })) as never,
    ingest: ingest as never,
    secretFor: () => 'test-only-secret',
    now: () => NOW,
  };
  const n = call({ attestedMemberId: URN }, { id: r.runId });
  await nextHandler(n.req, n.res, deps);
  if (n.res._json?.command !== 'read') throw new Error(`no read: ${JSON.stringify(n.res._json)}`);
  const p = call({
    pageIndex: 0, finalUrl: LIST, outcome: 'ok', hasNextPage: false, listTotal: leads.length,
    leads: leads.map((k) => ({ lead_key: k, full_name: `Lead ${k}` })), reader_version: 'snr-1', attestedMemberId: URN,
  }, { id: r.runId });
  await pagesHandler(p.req, p.res, deps);
  return { res: p.res, run: db.t.salesnav_extraction_runs[0], ingest };
}

describe('Sales Navigator page counter = canonical prospects', () => {
  it('new evidence on an EXISTING prospect is an update, not a new lead; a truly new person counts once', async () => {
    const { res, run } = await pageWith(() => [
      { externalId: 'a', ok: true, prospectId: 'p-new', prospectOutcome: 'created', provenanceOutcome: 'created' },
      { externalId: 'b', ok: true, prospectId: 'p-old', prospectOutcome: 'matched', provenanceOutcome: 'created' },
      { externalId: 'c', ok: true, prospectId: 'p-old2', prospectOutcome: 'matched', provenanceOutcome: 'unchanged' },
    ], ['keyA00001', 'keyA00002', 'keyA00003']);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ accepted: 3, created: 1, updated: 1, skippedDuplicates: 1, rejected: 0 });
    expect(run).toMatchObject({ created_count: 1, updated_count: 1, skipped_duplicates: 1 });
  });

  it('CONTROL: the same batch counted by evidence (the old rule) would have reported 2 new leads', async () => {
    const outcomes = [
      { prospectOutcome: 'created', provenanceOutcome: 'created' },
      { prospectOutcome: 'matched', provenanceOutcome: 'created' },
    ];
    expect(outcomes.filter((o) => o.provenanceOutcome === 'created').length).toBe(2);
    const { res } = await pageWith(() => outcomes.map((o, i) => ({ externalId: String(i), ok: true, prospectId: `p${i}`, ...o })), ['keyX00001', 'keyY00001']);
    expect(res._json.created).toBe(1);
  });

  it('several evidence records resolving to ONE prospect count once', async () => {
    const { res } = await pageWith(() => [
      { externalId: 'a', ok: true, prospectId: 'p1', prospectOutcome: 'created', provenanceOutcome: 'created' },
      { externalId: 'b', ok: true, prospectId: 'p1', prospectOutcome: 'matched', provenanceOutcome: 'created' },
    ], ['keyA00001', 'keyA00002']);
    expect(res._json).toMatchObject({ created: 1, updated: 1 });
  });

  it('distinct new prospects each count; failures are rejected; every accepted lead is accounted for', async () => {
    const { res } = await pageWith(() => [
      { externalId: 'a', ok: true, prospectId: 'p1', prospectOutcome: 'created', provenanceOutcome: 'created' },
      { externalId: 'b', ok: true, prospectId: 'p2', prospectOutcome: 'created', provenanceOutcome: 'created' },
      { externalId: 'c', ok: false, rejection: 'validation_failed' },
    ], ['keyA00001', 'keyA00002', 'keyA00003']);
    const b = res._json;
    expect(b).toMatchObject({ created: 2, updated: 0, rejected: 1 });
    expect(b.created + b.updated + b.skippedDuplicates + b.heldForReview + b.probeUnknown + b.rejected).toBe(b.accepted);
  });

  it('an outcome WITHOUT a prospect verdict is never counted as new', async () => {
    const { res } = await pageWith(() => [{ externalId: 'a', ok: true, prospectId: 'p1', provenanceOutcome: 'created' }], ['keyA00001']);
    expect(res._json).toMatchObject({ created: 0, updated: 1 });
  });

  it('tenant isolation: the batch is ingested for the SESSION company only', async () => {
    const { ingest } = await pageWith((recs) => recs.map((_r, i) => ({ externalId: String(i), ok: true, prospectId: `p${i}`, prospectOutcome: 'created', provenanceOutcome: 'created' })), ['keyA00001'], OTHER_ORG);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0].organizationId).toBe(OTHER_ORG);
  });
});
