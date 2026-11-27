/**
 * Round 30 / P0-2: the batch count is in PROSPECTS (canonical_leads), not evidence rows.
 * Pure function: every case names the bucket it expects, and the buckets always add up to the batch.
 */
import { tallyProspectOutcomes, type ProspectOutcomeLike } from '../../../lib/prospects/prospectOutcomeTally';

const ok = (prospectId: string | null, prospectOutcome: ProspectOutcomeLike['prospectOutcome'], provenanceOutcome: ProspectOutcomeLike['provenanceOutcome'] = 'created'): ProspectOutcomeLike =>
  ({ ok: true, prospectId, prospectOutcome, provenanceOutcome });

describe('tallyProspectOutcomes', () => {
  it('one prospect with several evidence records counts ONCE', () => {
    const t = tallyProspectOutcomes([
      ok('p1', 'created', 'created'),
      ok('p1', 'matched', 'created'),     // a second evidence row for the same prospect
      ok('p1', 'matched', 'changed'),
    ]);
    expect(t.newProspects).toBe(1);
    expect(t.updated).toBe(2);
    expect(t.total).toBe(3);
  });

  it('CONTROL - the old evidence-based count would have said 2 new for that batch', () => {
    const batch = [ok('p1', 'created', 'created'), ok('p1', 'matched', 'created')];
    expect(batch.filter((o) => o.provenanceOutcome === 'created').length).toBe(2);
    expect(tallyProspectOutcomes(batch).newProspects).toBe(1);
  });

  it('new evidence on an EXISTING prospect is an update, not a new prospect', () => {
    const t = tallyProspectOutcomes([ok('p9', 'matched', 'created')]);
    expect(t).toMatchObject({ newProspects: 0, updated: 1, unchanged: 0 });
  });

  it('distinct new prospects each count once', () => {
    const t = tallyProspectOutcomes([ok('a', 'created'), ok('b', 'created'), ok('c', 'created')]);
    expect(t.newProspects).toBe(3);
  });

  it('a repeated "created" for the same id (defensive) is counted once and the repeat as updated', () => {
    const t = tallyProspectOutcomes([ok('a', 'created'), ok('a', 'created')]);
    expect(t).toMatchObject({ newProspects: 1, updated: 1, total: 2 });
  });

  it('unchanged evidence on an existing prospect is "unchanged"', () => {
    expect(tallyProspectOutcomes([ok('p', 'matched', 'unchanged')])).toMatchObject({ unchanged: 1, updated: 0, newProspects: 0 });
  });

  it('a record with no prospect key is "withoutProspect", never new', () => {
    expect(tallyProspectOutcomes([ok(null, 'insufficient_evidence')])).toMatchObject({ withoutProspect: 1, newProspects: 0 });
  });

  it('a missing prospect verdict is "unclassified", never guessed as new', () => {
    const t = tallyProspectOutcomes([{ ok: true, prospectId: 'x', provenanceOutcome: 'created' }]);
    expect(t).toMatchObject({ unclassified: 1, newProspects: 0 });
  });

  it('review F-2: a record that CREATED its prospect and then failed still counts the prospect as new, once', () => {
    const t = tallyProspectOutcomes([
      { ok: false, prospectId: 'p', prospectOutcome: 'created' },
      { ok: true, prospectId: 'p', prospectOutcome: 'matched', provenanceOutcome: 'created' },   // the retry
    ]);
    expect(t).toMatchObject({ newProspects: 1, createdThenFailed: 1, updated: 1, rejected: 0, total: 2 });
  });

  it('a failure on an EXISTING prospect, or before any prospect, is rejected', () => {
    expect(tallyProspectOutcomes([{ ok: false, prospectId: 'p', prospectOutcome: 'matched' }, { ok: false }]))
      .toMatchObject({ rejected: 2, newProspects: 0, createdThenFailed: 0, total: 2 });
  });

  it('failed records are rejected; an empty batch is all zeros', () => {
    expect(tallyProspectOutcomes([{ ok: false }, { ok: false, prospectId: null }]))
      .toMatchObject({ rejected: 2, newProspects: 0, total: 2 });
    expect(tallyProspectOutcomes([])).toEqual({ newProspects: 0, updated: 0, unchanged: 0, withoutProspect: 0, unclassified: 0, rejected: 0, createdThenFailed: 0, total: 0 });
  });

  it('the buckets always add up to the batch', () => {
    const batch: ProspectOutcomeLike[] = [
      ok('a', 'created'), ok('a', 'matched', 'unchanged'), ok('b', 'matched'), ok(null, 'insufficient_evidence'),
      { ok: true, prospectId: 'z' }, { ok: false },
    ];
    const t = tallyProspectOutcomes(batch);
    expect(t.total).toBe(batch.length);
    expect(t).toMatchObject({ newProspects: 1, unchanged: 1, updated: 1, withoutProspect: 1, unclassified: 1, rejected: 1 });
  });
});
