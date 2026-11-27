/**
 * Round 30 / P0-2: THE count of an ingestion batch, in terms of the canonical Prospect (`canonical_leads`).
 *
 * The orchestrator reports two verdicts per record:
 *   - `provenanceOutcome` (LI-2) is about the EVIDENCE row (`source_records`): created / changed / unchanged.
 *   - `prospectOutcome` (WS-1, `resolveOrCreateProspect`) is about the PROSPECT: created / matched /
 *     insufficient_evidence. `created` is returned only by the one successful `canonical_leads` INSERT
 *     (prospectResolution.ts), so it is the only honest source for "new prospects".
 *
 * Counting new prospects from `provenanceOutcome === 'created'` (the previous Sales Navigator counter) counted new
 * EVIDENCE: a new source record for a person who was already a prospect read as a new prospect. This module is the
 * one place both the Sales Navigator page loop and the CSV import results count from, so they cannot drift apart.
 *
 * Rules, per outcome (every outcome lands in exactly one bucket, so the buckets add up to the batch):
 *   !ok, but prospectOutcome 'created' (the canonical row was inserted before a later step failed)
 *                                                                -> newProspects (it exists), also counted in
 *                                                                   createdThenFailed so the failure stays visible
 *   !ok otherwise                                                -> rejected
 *   ok, prospectOutcome 'created', a prospectId not seen before  -> newProspects   (a prospect counts ONCE)
 *   ok, a prospectId (matched, or a repeat of one created above) -> unchanged when the evidence was unchanged,
 *                                                                   else updated
 *   ok, no prospectId (insufficient_evidence)                    -> withoutProspect
 *   ok, no prospectOutcome at all                                -> unclassified (never guessed as new)
 *
 * Client-safe: no imports, no I/O. Counts only - nothing about the person is read or returned.
 */

export type ProspectOutcomeKind = 'created' | 'matched' | 'insufficient_evidence';

export interface ProspectOutcomeLike {
  readonly ok: boolean;
  readonly prospectId?: string | null;
  readonly prospectOutcome?: ProspectOutcomeKind | null;
  readonly provenanceOutcome?: 'created' | 'unchanged' | 'changed' | null;
}

export interface ProspectTally {
  /** Distinct canonical prospects this batch CREATED. */
  readonly newProspects: number;
  /** Records that attached new or changed evidence to an existing prospect. */
  readonly updated: number;
  /** Records whose evidence was already on file, unchanged. */
  readonly unchanged: number;
  /** Ingested records that resolved to no canonical prospect (no source identity key). */
  readonly withoutProspect: number;
  /** Ingested records whose prospect verdict was not reported. Never counted as new. */
  readonly unclassified: number;
  /** Of newProspects: created, then the record failed at a later step (evidence not recorded). Informational. */
  readonly createdThenFailed: number;
  /** Records the orchestrator refused or failed (excluding createdThenFailed, counted as new above). */
  readonly rejected: number;
  /** Every outcome counted: the sum of the six buckets. */
  readonly total: number;
}

export function tallyProspectOutcomes(outcomes: readonly ProspectOutcomeLike[]): ProspectTally {
  const created = new Set<string>();
  let updated = 0;
  let unchanged = 0;
  let withoutProspect = 0;
  let unclassified = 0;
  let rejected = 0;
  let createdThenFailed = 0;

  for (const o of outcomes) {
    const id = o && typeof o.prospectId === 'string' && o.prospectId !== '' ? o.prospectId : null;
    if (!o || o.ok !== true) {
      if (o && o.prospectOutcome === 'created' && id !== null && !created.has(id)) {
        created.add(id); createdThenFailed += 1; continue;
      }
      rejected += 1; continue;
    }
    const kind = o.prospectOutcome ?? null;
    if (kind === null) { unclassified += 1; continue; }
    if (id === null) { withoutProspect += 1; continue; }
    if (kind === 'created' && !created.has(id)) { created.add(id); continue; }
    if (o.provenanceOutcome === 'unchanged') unchanged += 1; else updated += 1;
  }

  const newProspects = created.size;
  return {
    newProspects, updated, unchanged, withoutProspect, unclassified, rejected, createdThenFailed,
    total: newProspects + updated + unchanged + withoutProspect + unclassified + rejected,
  };
}
