/**
 * The prospect IMPORT WIZARD gate (server). Read ONLY here (c6 2026-11-20, b3 ruling: default OFF).
 *
 * Allowed only when ALL hold, and it FAILS CLOSED on any lookup error:
 *   1. the existing lead-ingestion gate (ENABLE_LEAD_INGESTION + the tenant's `lead_ingestion` flag);
 *   2. the PI-LDB schema is applied (isPiLdbSchemaReady);
 *   3. the tenant's own `prospect_import` flag (featureFlagService; no row = OFF), flipped per pilot company with
 *      that service's activation/rollback audit.
 * Who turns it on: the owner, per pilot company, after the 0000..0007 apply (the ask goes to the owner via cb).
 */
import { evaluateFeatureFlag } from '../featureFlagService';
import { isPiLdbSchemaReady } from '../leadIntelligence/piLdbSchemaReady';
import { resolveLeadIngestionGate } from './orchestrator';

export const PROSPECT_IMPORT_FLAG_KEY = 'prospect_import';

export interface ProspectImportGateDecision { allowed: boolean; reason: string }

export async function resolveProspectImportGate(
  organizationId: string | null | undefined,
  deps: {
    ingestionGate?: typeof resolveLeadIngestionGate;
    schemaReady?: () => boolean;
    evaluate?: typeof evaluateFeatureFlag;
  } = {},
): Promise<ProspectImportGateDecision> {
  const ingestion = await (deps.ingestionGate ?? resolveLeadIngestionGate)(organizationId);
  if (!ingestion.allowed) return { allowed: false, reason: `ingestion:${ingestion.reason}` };
  if (!(deps.schemaReady ?? isPiLdbSchemaReady)()) return { allowed: false, reason: 'schema_not_ready' };
  try {
    const result = await (deps.evaluate ?? evaluateFeatureFlag)({
      organizationId: String(organizationId),
      flagKey: PROSPECT_IMPORT_FLAG_KEY,
      cohortKey: null,
    });
    // STRICT (round 30B): only a boolean true opens it; a malformed answer (missing, a string, null) stays closed.
    return result?.enabled === true
      ? { allowed: true, reason: `tenant_flag:${result.reason}` }
      : { allowed: false, reason: `tenant_flag:${result?.reason ?? 'malformed_answer'}` };
  } catch (e) {
    return { allowed: false, reason: `flag_evaluation_failed:${e instanceof Error ? e.message : String(e)}` };
  }
}
