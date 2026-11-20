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
 */
export function isPiLdbSchemaReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.PI_LDB_SCHEMA_READY ?? '').trim().toLowerCase() === 'true';
}
