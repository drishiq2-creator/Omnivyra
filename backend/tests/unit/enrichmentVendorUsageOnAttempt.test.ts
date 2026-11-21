/**
 * Vendor usage on the attempt ledger (own key only, owner 2026-11-20; central access = PL-171): every closed
 * enrichment attempt states who paid the vendor (funding: always the tenant), what the VENDOR billed
 * (provider_cost_units) and the Omnivyra credits charged (credits_charged: always 0).
 * Rewritten from a5f2e9647's modeBAttemptUsage.test.ts: the platform/settle cases are removed with mode B.
 *
 * PI review requirement: "a persistence failure after a paid answer must still
 * produce an attempt row with units consumed > 0 and credits_charged 0 or NULL".
 */
import { executeEnrichmentRecorded } from '../../services/enrichment/recordedExecution';

const NOW = '2026-11-10T12:00:00.000Z';
const ORG = '00000000-0000-4000-8000-0000000000aa';
const request = {
  organizationId: ORG, subject: 'person', entityId: 'p-1', attributes: ['job_title'],
  selectors: { linkedin_url: 'https://www.linkedin.com/in/jane' }, purpose: 't', correlationId: 'c1',
};

type Close = Record<string, unknown>;

async function run(opts: {
  vendor?: 'enriched' | 'no_match' | 'provider_unavailable';
  persistFails?: boolean;
  credentialMissing?: boolean;
  /** What resolveCredential returns instead of the tenant's key string. */
  credentialOverride?: unknown;
}) {
  const closes: Close[] = [];
  let calls = 0;
  const ports = {
    authorizeCost: async () => ({ authorized: true, holdId: 'h1', cost: { kind: 'unknown' } }),
    releaseCost: async () => undefined,
    resolveCredential: async () => ('credentialOverride' in opts ? opts.credentialOverride : (opts.credentialMissing ? null : 'k')),
    findRecentObservation: async () => null,
    persistObservation: async () => {
      if (opts.persistFails) throw new Error('db down');
      return { sourceRecordId: 's1', canonicalWithheld: [] };
    },
    now: () => NOW,
  };
  const vendor = opts.vendor ?? 'enriched';
  const adapter = {
    id: 'apollo', label: 'Apollo', supports: ['job_title'], credentialEnvVar: null, isAvailable: () => true,
    enrich: async () => {
      calls += 1;
      if (vendor === 'provider_unavailable') throw new Error('vendor 503');
      return vendor === 'enriched'
        ? { outcome: 'enriched', fields: [{ attribute: 'job_title', value: 'CTO' }], notReturned: [] }
        : { outcome: 'no_match', fields: [], notReturned: ['job_title'] };
    },
  };
  const recorder = {
    now: () => NOW, latest: async () => null, nextNumber: async () => 1,
    record: async () => ({ attemptId: 'a1' }),
    complete: async (input: Close) => { closes.push(input); },
    markPending: async () => undefined,
    claim: async () => ({ attemptId: 'a1', attemptNumber: 1, reclaimed: false }),
  };
  let error: unknown = null;
  try {
    await executeEnrichmentRecorded(request as never, 'apollo', ports as never, { adapter, recorder } as never);
  } catch (e) { error = e; }
  return { closes, calls, error };
}

it('PAID, NOT STORED (own key): the row still reports the vendor units, funding tenant, and 0 credits', async () => {
  const { closes, calls, error } = await run({ persistFails: true });
  expect(error).toBeInstanceOf(Error);
  expect(calls).toBe(1);
  expect(closes).toHaveLength(1);
  expect(closes[0]).toMatchObject({
    outcome: null, providerCallState: 'called', executionStatus: 'platform_failed',
    funding: 'tenant', providerCostUnits: 1, creditsCharged: 0,
  });
});

it('own key, enriched: units 1, funding tenant, 0 credits', async () => {
  const { closes } = await run({});
  expect(closes[0]).toMatchObject({ outcome: 'enriched', funding: 'tenant', providerCostUnits: 1, creditsCharged: 0 });
});

it('own key, a miss the vendor still bills (no_match): units 1, 0 credits', async () => {
  const { closes } = await run({ vendor: 'no_match' });
  expect(closes[0]).toMatchObject({ outcome: 'no_match', funding: 'tenant', providerCostUnits: 1, creditsCharged: 0 });
});

it('vendor error (not billable): called, 0 units, 0 credits', async () => {
  const { closes } = await run({ vendor: 'provider_unavailable' });
  expect(closes[0]).toMatchObject({ providerCallState: 'called', providerCostUnits: 0, creditsCharged: 0 });
});

it("mode B's old object credential ({value, funding:'platform'}) is REFUSED as credential_missing - no call", async () => {
  const { closes, calls } = await run({ credentialOverride: { value: 'k', funding: 'platform' } });
  expect(calls).toBe(0);
  expect(closes[0]).toMatchObject({ outcome: 'credential_missing', providerCallState: 'not_called' });
});

it('NEGATIVE CONTROL: no credential -> no call; units, funding and credits are left unstated (NULL)', async () => {
  const { closes, calls } = await run({ credentialMissing: true });
  expect(calls).toBe(0);
  expect(closes[0]).toMatchObject({ outcome: 'credential_missing', providerCallState: 'not_called' });
  expect('providerCostUnits' in closes[0]).toBe(false);
  expect('funding' in closes[0]).toBe(false);
  expect('creditsCharged' in closes[0]).toBe(false);
});
