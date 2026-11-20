/**
 * PI-LDB schema readiness: ONE switch, read ONLY here (c6 2026-11-20, b3 ruling: deploy decoupled from the apply).
 *
 * 20270211000003 (lead_intelligence.display) and 0005 (origin_category / origin_observed_at) add columns that the
 * lead_intelligence repository now writes. That repository serves EVERY live lead source (leadService,
 * crmIngestionService, opportunityFeedService, marketPulseIntelligenceService, canonicalLeadSignalService and lead
 * ingestion), so writing those columns before the apply would fail every lead_intelligence write in production.
 *
 * OFF (default): the repository writes exactly main's column set. ON: set PI_LDB_SCHEMA_READY=true ONLY after the
 * owner-approved apply of 20270211000000..07 AND a presence check of all of them (enable checklist). Nothing can be
 * wiped by the OFF period: the columns either do not exist yet, or exist with no values written.
 *
 * GATE THE WRITE, NEVER THE READ (7c, 2026-11-20). The read (leadIntelligenceRepository rowToView: `row.display`,
 * `row.origin_category`) is deliberately UNGATED, so persisted values stay visible whatever this switch says - a
 * reader that disappears when a rollout flag flips would hide real data. It is safe BEFORE the apply only because
 * the view reads (getCanonicalLead, listCanonicalLeads) use `select('*')`: an absent column arrives as `undefined`
 * and the falsy test skips it. If either read moves to an explicit column list naming display / origin_*, every
 * pre-apply read FAILS and this switch no longer decouples anything. PINNED: piLdbRolloutGates.test.ts.
 */
export function isPiLdbSchemaReady(env: NodeJS.ProcessEnv = process.env): boolean {
  // STRICT (7c 2026-11-20): ON is the dangerous state (writes columns that may not exist), so only the exact string
  // 'true' opens it - a config tool that writes 'True' or ' true' stays OFF. Same parse as the WhatsApp launch gate.
  return env.PI_LDB_SCHEMA_READY === 'true';
}
