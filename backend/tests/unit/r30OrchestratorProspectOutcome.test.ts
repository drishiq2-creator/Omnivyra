/**
 * Round 30 / P0-2 — `ingestLeadBatch` reports WS-1's PROSPECT verdict (`prospectOutcome`) next to the evidence
 * verdict (`provenanceOutcome`), and the shared tally counts new prospects from it.
 *
 * REAL: ingestLeadBatch, the adapter registry, the manual adapter, validation and the outcome assembly (the subject).
 * DOUBLED (no database in a unit test), copied from piLdbBatchCounters.test.ts: identity, account, prospect resolution,
 * the provenance boundary, duplicates, the flag service, the durable sink, the contribution writer, reconciliation.
 * The provenance double ALWAYS answers 'created' - new evidence for every row - so a count taken from evidence would
 * call every row new; only the prospect verdict can tell them apart.
 */
// A MODULE, not a script: without an import/export this file shares the global scope with every other test file in
// the backend-tests typecheck, and its ORG / rec / load / Verdict collide with piLdbBatchCounters.test.ts.
export {};

const ORG = '00000000-0000-4000-8000-0000000000aa';

type Verdict = 'created' | 'matched' | 'insufficient_evidence';

function load(verdictFor: Record<string, Verdict>, opts: { provenanceThrows?: boolean } = {}) {
  jest.resetModules();
  process.env.ENABLE_LEAD_INGESTION = 'true';
  jest.doMock('../../services/featureFlagService', () => ({
    evaluateFeatureFlag: jest.fn(async () => ({ enabled: true, reason: 'test' })),
  }));
  jest.doMock('../../services/prospectIdentity/ingestionBoundary', () => ({
    ingestSourceRecord: jest.fn(async () => { if (opts.provenanceThrows) throw new Error('provenance down'); return ({
      sourceRecordId: 'sr-1', outcome: 'created', assertionsRecorded: 1, assertionsAlreadyPresent: 0,
      canonicalApplied: [], canonicalWithheld: [],
    }); }),
  }));
  jest.doMock('../../services/identityResolutionService', () => ({
    resolveUnifiedPerson: jest.fn(async () => ({ unifiedPersonId: 'person-1', matchedBy: 'email', created: false })),
  }));
  jest.doMock('../../services/prospectIdentity/accountResolution', () => ({
    resolveOrCreateAccount: jest.fn(async () => ({ accountId: 'account-1', outcome: 'created' })),
    attachPersonToAccount: jest.fn(async () => undefined),
  }));
  const resolver = jest.fn(async (organizationId: string, input: { fullName?: string | null }) => {
    const verdict = verdictFor[input?.fullName ?? ''] ?? 'matched';
    return {
      organizationId,
      prospectId: verdict === 'insufficient_evidence' ? null : `prospect-${input?.fullName}`,
      subjectId: 'subject-1', outcome: verdict, externalLeadKey: 'K', reason: verdict,
    };
  });
  jest.doMock('../../services/prospectIdentity/prospectResolution', () => ({ resolveOrCreateProspect: resolver }));
  jest.doMock('../../services/prospectIdentity/personDuplicates', () => ({
    detectAndParkDuplicates: jest.fn(async () => ({ detected: [], parked: 0, alreadyOpen: 0 })),
  }));
  jest.doMock('../../services/leadIntelligence/durableLeadIntelligenceSink', () => ({
    durableLeadIntelligenceSink: {
      emit: jest.fn(async () => ({ status: 'persisted', leadId: 'lead-1', reason: null, warnings: [], error: null })),
    },
  }));
  jest.doMock('../../services/prospectProvenance/ingestion/piIngestionContribution', () => ({
    ...(jest.requireActual('../../services/prospectProvenance/ingestion/piIngestionContribution') as object),
    recordPiIngestionContribution: jest.fn(async () => ({ status: 'inserted', id: 'c-1', role: 'originating', roleDowngraded: false })),
  }));
  jest.doMock('../../services/prospectProvenance/identityReconciliation', () => ({
    ...(jest.requireActual('../../services/prospectProvenance/identityReconciliation') as object),
    reconcileVerifiedPersonIdentities: jest.fn(async () => []),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../../services/leadIngestion') as typeof import('../../services/leadIngestion');
  pkg.registerBuiltInLeadSources();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const orch = require('../../services/leadIngestion/orchestrator') as typeof import('../../services/leadIngestion/orchestrator');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tallyProspectOutcomes } = require('../../../lib/prospects/prospectOutcomeTally') as typeof import('../../../lib/prospects/prospectOutcomeTally');
  return { orch, tallyProspectOutcomes, resolver };
}

const rec = (name: string) => ({ organizationId: ORG, referenceId: `ref-${name}`, fullName: name, email: `${name.toLowerCase()}@x.example` });

const savedIngestion = process.env.ENABLE_LEAD_INGESTION;
afterEach(() => {
  jest.resetModules();
  jest.dontMock('../../services/prospectIdentity/prospectResolution');
  // load() sets the kill switch for THIS process only; put it back so no later suite inherits it
  if (savedIngestion === undefined) delete process.env.ENABLE_LEAD_INGESTION; else process.env.ENABLE_LEAD_INGESTION = savedIngestion;
});

describe('ingestLeadBatch reports the prospect verdict', () => {
  it('each ingested outcome carries prospectOutcome from the resolver, alongside provenanceOutcome', async () => {
    const { orch } = load({ New: 'created', Old: 'matched', NoKey: 'insufficient_evidence' });
    const r = await orch.ingestLeadBatch({ organizationId: ORG, source: 'manual', records: [rec('New'), rec('Old'), rec('NoKey')] });
    expect(r.outcomes.map((o) => [o.ok, o.prospectOutcome, o.provenanceOutcome])).toEqual([
      [true, 'created', 'created'],
      [true, 'matched', 'created'],
      [true, 'insufficient_evidence', 'created'],
    ]);
  });

  it('the tally counts ONE new prospect where the evidence verdict says three', async () => {
    const { orch, tallyProspectOutcomes } = load({ New: 'created', Old: 'matched', NoKey: 'insufficient_evidence' });
    const r = await orch.ingestLeadBatch({ organizationId: ORG, source: 'manual', records: [rec('New'), rec('Old'), rec('NoKey')] });
    expect(r.outcomes.filter((o) => o.provenanceOutcome === 'created')).toHaveLength(3);   // the old count
    expect(tallyProspectOutcomes(r.outcomes)).toMatchObject({ newProspects: 1, updated: 1, withoutProspect: 1, rejected: 0, total: 3 });
  });

  it('a record refused before prospect resolution carries NO prospect verdict', async () => {
    const { orch, resolver } = load({});
    const r = await orch.ingestLeadBatch({ organizationId: ORG, source: 'manual', records: [{ organizationId: ORG, fullName: 'NoContact' }] });
    expect(r.outcomes[0].ok).toBe(false);
    expect(r.outcomes[0].prospectOutcome).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('review F-2: a prospect CREATED before a provenance failure is still reported (and counted as new, once)', async () => {
    const { orch, tallyProspectOutcomes } = load({ New: 'created' }, { provenanceThrows: true });
    const r = await orch.ingestLeadBatch({ organizationId: ORG, source: 'manual', records: [rec('New')] });
    expect(r.outcomes[0]).toMatchObject({ ok: false, rejection: 'provenance_failed', prospectId: 'prospect-New', prospectOutcome: 'created' });
    expect(tallyProspectOutcomes(r.outcomes)).toMatchObject({ newProspects: 1, createdThenFailed: 1, rejected: 0 });
  });

  it('the resolver is called with the BATCH tenant (tenant boundary unchanged)', async () => {
    const { orch, resolver } = load({ New: 'created' });
    await orch.ingestLeadBatch({ organizationId: ORG, source: 'manual', records: [rec('New')] });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0]).toBe(ORG);
  });
});
